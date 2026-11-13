import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, patientUrls, postToolConfig } from '../src/myMri/api'
import { getToolConfig } from '../src/myMri/config'

vi.mock('../src/runtime/env', () => ({ getApiBaseUrl: () => 'http://api.test/api' }))

const enc = new TextEncoder()
function sse(...events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  // Split mid-event to exercise buffering across chunks.
  const mid = Math.floor(text.length / 2)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, mid)))
      c.enqueue(enc.encode(text.slice(mid)))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

afterEach(() => { vi.unstubAllGlobals() })

describe('postToolConfig', () => {
  it('posts the bundled config and resolves on complete', async () => {
    const fetchMock = vi.fn(async () => sse(['complete', { assay: 'a-1', cases: ['sub-1'] }]))
    vi.stubGlobal('fetch', fetchMock)
    const res = await postToolConfig(getToolConfig(), () => {})
    expect(res.cases).toEqual(['sub-1'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/tool-config')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string).assay_info.cohorts).toEqual(['sub-1'])
  })

  it('reports progress events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(
      ['progress', { step: 'resolve', case: 'sub-1', current: 1, total_cases: 2 }],
      ['complete', { assay: 'a', cases: [] }],
    )))
    const onProgress = vi.fn()
    await postToolConfig(getToolConfig(), onProgress)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ case: 'sub-1', current: 1, total_cases: 2 }))
  })

  it('shows the backend summary on a 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { detail: { step: 'minio', summary: 'Dataset missing', detail: 'no xlsx' } })))
    await expect(postToolConfig(getToolConfig(), () => {})).rejects.toMatchObject({
      summary: 'Dataset missing', detail: 'no xlsx', step: 'minio',
    })
  })

  it('rejects on an SSE error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(['error', { step: '1.3', summary: 'Bad sheet', detail: 'row 2' }])))
    await expect(postToolConfig(getToolConfig(), () => {})).rejects.toMatchObject({ summary: 'Bad sheet', step: '1.3' })
  })

  it('gives a generic summary when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(postToolConfig(getToolConfig(), () => {})).rejects.toMatchObject({
      summary: 'The server could not be reached.',
    })
  })
})

describe('fetchJson', () => {
  it('maps a 409 to assay_not_loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { detail: { code: 'assay_not_loaded', summary: 'Reload' } })))
    await expect(fetchJson('http://x')).rejects.toMatchObject({ code: 'assay_not_loaded', summary: 'Reload' })
  })
  it('treats a proxy page in place of the backend (502, 503, 504) as the server being unreachable', async () => {
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status })))
      await expect(fetchJson('http://x')).rejects.toMatchObject({
        summary: 'The server could not be reached.', detail: `HTTP ${status}`,
      })
    }
  })
  it('says the server answered with an error when its body is not one of ours', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })))
    await expect(fetchJson('http://x')).rejects.toMatchObject({
      summary: 'The server returned an error (HTTP 500).', detail: 'HTTP 500',
    })
    // FastAPI's own validation error: `detail` is a list, not our {code, summary}.
    vi.stubGlobal('fetch', vi.fn(async () => json(422, { detail: [{ loc: ['query', 'tz'], msg: 'bad', type: 'x' }] })))
    await expect(fetchJson('http://x')).rejects.toMatchObject({
      summary: 'The server returned an error (HTTP 422).', detail: 'HTTP 422',
    })
  })
})

describe('patientUrls', () => {
  it('builds URLs from getApiBaseUrl and encodes the parts', () => {
    const u = patientUrls('a b', 'sub/1')
    expect(u.mri).toBe('http://api.test/api/patients/a%20b/sub%2F1/mri')
    expect(u.findings).toBe('http://api.test/api/patients/a%20b/sub%2F1/findings')
    expect(u.mask).toBe('http://api.test/api/patients/a%20b/sub%2F1/mask.glb')
    expect(u.report('Pacific/Auckland')).toBe('http://api.test/api/patients/a%20b/sub%2F1/report.pdf?tz=Pacific%2FAuckland')
  })
})

describe('postToolConfig SSE framing', () => {
  const streamOf = (...chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach(ch => c.enqueue(ch)); c.close() },
  }), { status: 200 })

  it('parses CRLF framing, including a CR/LF split across chunks', async () => {
    const onProgress = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => streamOf(
      enc.encode('event: progress\r\ndata: {"case":"sub-1","current":1,"total_cases":1}\r'),
      enc.encode('\n\r\nevent: complete\r\ndata: {"assay":"a","cases":["sub-1"]}\r\n\r\n'),
    )))
    const res = await postToolConfig(getToolConfig(), onProgress)
    expect(res.assay).toBe('a')
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('parses a final event with no trailing blank line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamOf(
      enc.encode('event: complete\ndata: {"assay":"a","cases":[]}'),
    )))
    await expect(postToolConfig(getToolConfig(), () => {})).resolves.toMatchObject({ assay: 'a' })
  })

  it('joins multi-line data fields with a newline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamOf(
      enc.encode('event: complete\ndata: {"assay":\ndata: "a","cases":[]}\n\n'),
    )))
    await expect(postToolConfig(getToolConfig(), () => {})).resolves.toMatchObject({ assay: 'a' })
  })

  it('keeps a multi-byte character split across two chunks intact', async () => {
    const bytes = enc.encode('event: error\ndata: {"summary":"caf\u00e9 \u2014 down","detail":""}\n\n')
    const cut = bytes.indexOf(0xc3) + 1 // between the two bytes of "\u00e9"
    vi.stubGlobal('fetch', vi.fn(async () => streamOf(bytes.slice(0, cut), bytes.slice(cut))))
    await expect(postToolConfig(getToolConfig(), () => {})).rejects.toMatchObject({ summary: 'caf\u00e9 \u2014 down' })
  })

  it('cancels the reader once complete has been handled', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('event: complete\ndata: {"assay":"a","cases":[]}\n\n')) },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    await postToolConfig(getToolConfig(), () => {})
    expect(cancel).toHaveBeenCalled()
  })
})
