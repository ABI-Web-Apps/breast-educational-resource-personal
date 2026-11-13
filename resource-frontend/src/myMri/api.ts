import { getApiBaseUrl } from '@/runtime/env'
import type { ToolConfig } from '@/myMri/config'

/** A failure the page can show to the reader as-is. */
export interface MyMriError {
  summary: string
  detail: string
  code?: string
  step?: string
}

export interface ProgressEvent { case: string, current: number, total_cases: number }

const UNREACHABLE = 'The server could not be reached.'

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function isMyMriError(e: unknown): e is MyMriError {
  return typeof e === 'object' && e !== null && 'summary' in e && 'detail' in e
}

/** Turn a non-2xx response into a MyMriError, reading whatever the backend sent. */
async function errorFromResponse(res: Response): Promise<MyMriError> {
  let body: any = null
  try { body = JSON.parse(await res.text()) } catch { body = null }
  const d = body?.detail
  if (d && typeof d === 'object' && typeof d.summary === 'string') {
    const err: MyMriError = { summary: d.summary, detail: typeof d.detail === 'string' ? d.detail : `HTTP ${res.status}` }
    if (typeof d.code === 'string') err.code = d.code
    if (typeof d.step === 'string') err.step = d.step
    if (res.status === 409 && !err.code) err.code = 'assay_not_loaded'
    return err
  }
  const err: MyMriError = { summary: UNREACHABLE, detail: `HTTP ${res.status}` }
  if (res.status === 409) err.code = 'assay_not_loaded'
  return err
}

/** Normalise anything thrown by fetch or the reader into a MyMriError (aborts pass through). */
function toMyMriError(e: unknown): unknown {
  if (isAbort(e) || isMyMriError(e)) return e
  const err: MyMriError = { summary: UNREACHABLE, detail: e instanceof Error ? e.message : String(e) }
  return err
}

export async function postToolConfig(
  config: ToolConfig,
  onProgress: (e: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ cases: string[], assay: string }> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/tool-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal,
    })
    if (!res.ok) throw await errorFromResponse(res)
    if (!res.body) throw { summary: UNREACHABLE, detail: 'Empty response body' } as MyMriError

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()!
      for (const part of parts) {
        let name = ''
        let data = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!name || !data) continue
        const payload = JSON.parse(data)
        if (name === 'progress') onProgress(payload)
        else if (name === 'complete') return { cases: payload.cases ?? [], assay: payload.assay }
        else if (name === 'error') {
          throw {
            summary: payload.summary ?? 'Something went wrong.',
            detail: payload.detail ?? '',
            step: payload.step,
          } as MyMriError
        }
      }
    }
    throw { summary: UNREACHABLE, detail: 'The stream ended before it completed.' } as MyMriError
  } catch (e) {
    throw toMyMriError(e)
  }
}

export function patientUrls(assayUuid: string, cohort: string) {
  const base = `${getApiBaseUrl()}/patients/${encodeURIComponent(assayUuid)}/${encodeURIComponent(cohort)}`
  return {
    mri: `${base}/mri`,
    findings: `${base}/findings`,
    mask: `${base}/mask.glb`,
    report: (tz: string) => `${base}/report.pdf?tz=${encodeURIComponent(tz)}`,
  }
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) throw await errorFromResponse(res)
    return await res.json() as T
  } catch (e) {
    throw toMyMriError(e)
  }
}
