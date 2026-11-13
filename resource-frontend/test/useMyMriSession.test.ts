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
