import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MyMriReport from '../src/components/myMri/MyMriReport.vue'

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const pdfRes = () => new Response(new Blob(['%PDF-1.7 test'], { type: 'application/pdf' }), { status: 200 })
const urlFor = (tz: string) => `/api/patients/a/sub-1/report.pdf?tz=${encodeURIComponent(tz)}`
const withReload = <T>(fn: () => Promise<T>) => fn()

let create: ReturnType<typeof vi.spyOn>
let revoke: ReturnType<typeof vi.spyOn>
const mounted: { unmount: () => void }[] = []

function mountReport(props: Record<string, unknown> = {}) {
  const w = mount(MyMriReport, { props: { urlFor, cohort: 'sub-1', withReload, ...props } })
  mounted.push(w)
  return w
}
function setViewer(value: boolean | undefined) {
  Object.defineProperty(navigator, 'pdfViewerEnabled', { value, configurable: true })
}

describe('MyMriReport', () => {
  beforeEach(() => {
    create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report-1')
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => pdfRes()))
    setViewer(true)
  })
  afterEach(async () => {
    mounted.splice(0).forEach(w => w.unmount())
    await flushPromises()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setViewer(undefined)
  })

  it('shows the PDF in an iframe from an object URL', async () => {
    const w = mountReport()
    await flushPromises()
    const frame = w.get('iframe')
    expect(frame.attributes('src')).toBe('blob:report-1')
    expect(frame.attributes('title')).toBe('Your MRI report')
    const dl = w.get('a[download]')
    expect(dl.attributes('href')).toBe('blob:report-1')
    expect(dl.attributes('download')).toBe('sub-1-mri-report.pdf')
  })

  it('sends the reader time zone', async () => {
    mountReport()
    await flushPromises()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(`tz=${encodeURIComponent(tz)}`)
  })

  it('offers Open and Download when there is no PDF viewer', async () => {
    setViewer(false)
    const w = mountReport()
    await flushPromises()
    expect(w.find('iframe').exists()).toBe(false)
    const open = w.get('a[target="_blank"]')
    expect(open.attributes('href')).toBe('blob:report-1')
    expect(open.attributes('rel')).toBe('noopener')
    expect(open.text()).toContain('Open report')
    expect(w.get('a[download]').exists()).toBe(true)
  })

  it('shows the Docker message on 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(503, {
      detail: { code: 'report_unavailable', summary: 'Report rendering needs the Docker backend.' },
    })))
    const w = mountReport()
    await flushPromises()
    expect(w.text()).toContain('Report rendering needs the Docker backend.')
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('a[download]').exists()).toBe(false)
  })

  it('says there is no report without findings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(404, { detail: { code: 'no_findings', summary: 'x' } })))
    const w = mountReport()
    await flushPromises()
    expect(w.text()).toContain('No report is available for this scan.')
  })

  it('shows the backend summary for other errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(503, { detail: { code: 'input_unreadable', summary: 'Your files could not be read.' } })))
    const w = mountReport()
    await flushPromises()
    expect(w.text()).toContain('Your files could not be read.')
  })

  it('refetches only the report on Try again, without touching the session', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(503, { detail: { code: 'report_unavailable', summary: 'Nope.' } }))
      .mockResolvedValueOnce(pdfRes())
    vi.stubGlobal('fetch', f)
    const reload = vi.fn(<T,>(fn: () => Promise<T>) => fn())
    const w = mountReport({ withReload: reload })
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(1)
    await w.get('button').trigger('click')
    await flushPromises()
    // Each attempt is one report request through withReload; nothing else was fetched.
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls.every(c => String(c[0]).includes('report.pdf'))).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
    expect(w.get('iframe').attributes('src')).toBe('blob:report-1')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('makes its loading and error states the live region', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r })))
    const w = mountReport()
    expect(w.get('[data-state="loading"]').attributes('role')).toBe('status')
    finish(jsonRes(503, { detail: { code: 'report_unavailable', summary: 'Nope.' } }))
    await flushPromises()
    expect(w.get('[data-state="error"]').attributes('role')).toBe('alert')
    expect(w.findAll('[role="alert"],[role="status"]')).toHaveLength(1)
  })

  it('ignores a slow first response after a retry', async () => {
    const resolvers: ((r: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolvers.push(r) })))
    const w = mountReport()
    const refetch = (w.vm as unknown as { refetch: () => Promise<void> }).refetch
    void refetch()
    resolvers[1]!(pdfRes())
    await flushPromises()
    create.mockReturnValue('blob:newer')
    resolvers[0]!(pdfRes())
    await flushPromises()
    expect(create).toHaveBeenCalledTimes(1)
    expect(w.get('iframe').attributes('src')).toBe('blob:report-1')
  })

  it('creates no object URL when a response arrives after unmount', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r })))
    const w = mountReport()
    w.unmount()
    finish(pdfRes())
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
  })

  it('revokes the previous object URL when refetching', async () => {
    const w = mountReport()
    await flushPromises()
    create.mockReturnValue('blob:report-2')
    ;(w.vm as unknown as { refetch: () => void }).refetch()
    await flushPromises()
    expect(revoke).toHaveBeenCalledWith('blob:report-1')
    expect(w.get('iframe').attributes('src')).toBe('blob:report-2')
  })

  it('revokes the object URL on unmount', async () => {
    const w = mountReport()
    await flushPromises()
    w.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:report-1')
  })

  it('aborts the request on unmount without showing an error', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise((_r, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    const w = mountReport()
    w.unmount()
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('re-posts through withReload on a 409', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes(409, { detail: { code: 'assay_not_loaded', summary: 's' } }))
      .mockResolvedValueOnce(pdfRes())
    vi.stubGlobal('fetch', f)
    const reload = vi.fn(async <T,>(fn: () => Promise<T>) => {
      try { return await fn() } catch { return fn() }
    })
    const w = mountReport({ withReload: reload })
    await flushPromises()
    expect(reload).toHaveBeenCalled()
    expect(w.find('iframe').exists()).toBe(true)
  })
})
