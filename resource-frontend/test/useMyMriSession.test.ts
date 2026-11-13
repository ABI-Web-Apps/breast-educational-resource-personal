import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { useMyMriSession } from '../src/myMri/useMyMriSession'

vi.mock('../src/runtime/env', () => ({ getApiBaseUrl: () => 'http://api.test/api' }))

const enc = new TextEncoder()
const toolConfigOk = () => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(enc.encode(`event: complete\ndata: ${JSON.stringify({ assay: 'a-1', cases: ['sub-1'] })}\n\n`))
    c.close()
  },
}), { status: 200 })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const record = { findings: [
  { label: 'Finding 1', lesion: { channel: 1, color: '#ff7043' } },
  { label: 'Finding 2', lesion: { channel: 2, color: '#42a5f5' } },
] }
const notLoaded = () => json(409, { detail: { code: 'assay_not_loaded', summary: 'Reload' } })
const toolConfigFails = () => json(400, { detail: { step: 'minio', summary: 'Dataset ... missing', detail: 'x' } })

function setup() {
  let session!: ReturnType<typeof useMyMriSession>
  const wrapper = mount(defineComponent({
    setup() { session = useMyMriSession(); return () => null },
  }))
  return { session, wrapper }
}

/** Per-endpoint response queues; the last entry repeats once the queue is down to one. */
function route(handlers: Record<'tool-config' | 'findings', (() => Response)[]>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = url.includes('tool-config') ? 'tool-config' : 'findings'
    calls.push(key)
    const queue = handlers[key]
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    return next()
  }))
  return calls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('useMyMriSession', () => {
  it('loads findings after tool-config', async () => {
    route({ 'tool-config': [toolConfigOk], findings: [() => json(200, record)] })
    const { session } = setup()
    await flushPromises()
    expect(session.status.value).toBe('ready')
    expect(session.cohort.value).toBe('sub-1')
    expect(session.urls.value!.findings).toBe('http://api.test/api/patients/a-1/sub-1/findings')
    expect(session.findings.value).toEqual([
      { label: 'Finding 1', channel: 1, color: '#ff7043' },
      { label: 'Finding 2', channel: 2, color: '#42a5f5' },
    ])
  })

  it('shows the backend summary on a 400', async () => {
    route({ 'tool-config': [toolConfigFails], findings: [notLoaded] })
    const { session } = setup()
    await flushPromises()
    expect(session.status.value).toBe('error')
    expect(session.error.value!.summary).toBe('Dataset ... missing')
  })

  it('re-posts once on 409', async () => {
    const calls = route({
      'tool-config': [toolConfigOk],
      findings: [notLoaded, () => json(200, record)],
    })
    const { session } = setup()
    await flushPromises()
    expect(calls).toEqual(['tool-config', 'findings', 'tool-config', 'findings'])
    expect(session.status.value).toBe('ready')
    expect(session.findings.value).toHaveLength(2)
  })

  it('gives up after a second 409', async () => {
    const calls = route({ 'tool-config': [toolConfigOk], findings: [notLoaded] })
    const { session } = setup()
    await flushPromises()
    expect(calls).toEqual(['tool-config', 'findings', 'tool-config', 'findings'])
    expect(session.status.value).toBe('error')
    expect(session.error.value!.code).toBe('assay_not_loaded')
  })

  it('treats a missing findings record as no findings', async () => {
    route({
      'tool-config': [toolConfigOk],
      findings: [() => json(404, { detail: { code: 'no_findings', summary: 'none' } })],
    })
    const { session } = setup()
    await flushPromises()
    expect(session.status.value).toBe('ready')
    expect(session.error.value).toBeNull()
    expect(session.findings.value).toEqual([])
  })

  it('retries from scratch on reload() after an error', async () => {
    route({
      'tool-config': [toolConfigFails, toolConfigOk],
      findings: [() => json(200, record)],
    })
    const { session } = setup()
    await flushPromises()
    expect(session.status.value).toBe('error')
    await session.reload()
    expect(session.status.value).toBe('ready')
    expect(session.error.value).toBeNull()
  })

  it('aborts in-flight requests on unmount without surfacing an error', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    const { session, wrapper } = setup()
    await flushPromises()
    wrapper.unmount()
    await flushPromises()
    expect(signal!.aborted).toBe(true)
    expect(session.error.value).toBeNull()
  })
})

describe('withReload contract', () => {
  const ready = async () => {
    const calls = route({ 'tool-config': [toolConfigOk], findings: [() => json(200, record)] })
    const made = setup()
    await flushPromises()
    calls.length = 0
    return { ...made, calls }
  }
  const e409 = { summary: 'Reload', detail: '', code: 'assay_not_loaded' }

  it('rethrows a non-409 error from fn and leaves the session ready', async () => {
    const { session } = await ready()
    const boom = { summary: 'Report unavailable', detail: '', code: 'report_unavailable' }
    await expect(session.withReload(async () => { throw boom })).rejects.toBe(boom)
    expect(session.status.value).toBe('ready')
    expect(session.error.value).toBeNull()
    expect(session.findings.value).toHaveLength(2)
  })

  it('re-posts on 409 and retries fn', async () => {
    const { session, calls } = await ready()
    const fn = vi.fn().mockRejectedValueOnce(e409).mockResolvedValueOnce('ok')
    await expect(session.withReload(fn)).resolves.toBe('ok')
    expect(calls).toEqual(['tool-config'])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rethrows a failed retry and leaves the session untouched', async () => {
    const { session } = await ready()
    const second = { summary: 'Still gone', detail: '', code: 'assay_not_loaded' }
    const fn = vi.fn().mockRejectedValueOnce(e409).mockRejectedValueOnce(second)
    await expect(session.withReload(fn)).rejects.toBe(second)
    expect(session.status.value).toBe('ready')
    expect(session.error.value).toBeNull()
  })

  it('sets the session error when the re-post itself fails', async () => {
    route({ 'tool-config': [toolConfigOk, toolConfigFails], findings: [() => json(200, record)] })
    const { session } = setup()
    await flushPromises()
    const fn = vi.fn().mockRejectedValue(e409)
    await expect(session.withReload(fn)).rejects.toMatchObject({ summary: 'Dataset ... missing' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(session.status.value).toBe('error')
    expect(session.error.value!.summary).toBe('Dataset ... missing')
  })

  it('shares one re-post between concurrent callers', async () => {
    const { session, calls } = await ready()
    const make = () => vi.fn().mockRejectedValueOnce(e409).mockResolvedValueOnce('ok')
    await Promise.all([session.withReload(make()), session.withReload(make())])
    expect(calls.filter(c => c === 'tool-config')).toHaveLength(1)
  })
})

describe('stale runs and bad data', () => {
  it('ignores the late result of a superseded run', async () => {
    let release!: (r: Response) => void
    const stale = new Promise<Response>((r) => { release = r })
    let findingsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('tool-config')) return toolConfigOk()
      return findingsCalls++ === 0
        ? stale
        : json(200, { findings: [{ label: 'New', lesion: { channel: 1, color: '#ff7043' } }] })
    }))
    const { session } = setup()
    await flushPromises()
    await session.reload()
    expect(session.findings.value.map(f => f.label)).toEqual(['New'])
    release(json(200, record))
    await flushPromises()
    expect(session.findings.value.map(f => f.label)).toEqual(['New'])
    expect(session.status.value).toBe('ready')
  })

  it('reports a malformed findings record as a normal error', async () => {
    route({ 'tool-config': [toolConfigOk], findings: [() => json(200, { findings: [{ label: 'x' }] })] })
    const { session } = setup()
    await flushPromises()
    expect(session.status.value).toBe('error')
    expect(session.error.value!.summary).toBeTruthy()
    expect(session.error.value).not.toBeInstanceOf(Error)
  })
})
