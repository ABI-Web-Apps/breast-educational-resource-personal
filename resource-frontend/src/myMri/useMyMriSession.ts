import { computed, onBeforeUnmount, ref } from 'vue'
import { fetchJson, isAbort, patientUrls, postToolConfig } from '@/myMri/api'
import type { MyMriError } from '@/myMri/api'
import { getToolConfig } from '@/myMri/config'

export interface FindingSummary { label: string, channel: number, color: string }

interface FindingsRecord {
  findings?: { label: string, lesion: { channel: number, color: string } }[]
}

function mapFindings(record: FindingsRecord | null): FindingSummary[] {
  try {
    return (record?.findings ?? []).map(f => ({
      label: f.label, channel: f.lesion.channel, color: f.lesion.color,
    }))
  } catch {
    const err: MyMriError = {
      summary: 'Your findings could not be read.',
      detail: 'The findings record is not in the expected format.',
      code: 'invalid_findings',
    }
    throw err
  }
}

/**
 * One page mount's worth of backend state: posts the tool config, then loads
 * the findings. Everything in flight is aborted when the page unmounts.
 */
export function useMyMriSession() {
  const controller = new AbortController()
  const status = ref<'loading' | 'ready' | 'error'>('loading')
  const progress = ref(0)
  const total = ref(0)
  const error = ref<MyMriError | null>(null)
  const assay = ref<string | null>(null)
  const findings = ref<FindingSummary[]>([])
  const config = getToolConfig()

  // Bumped by every reload(); a run that is no longer current may not touch state.
  let generation = 0
  // Shared by all callers that need the config posted again at the same time.
  let reposting: Promise<void> | null = null

  const cohort = computed(() => config.assay_info.cohorts[0] ?? '')
  const urls = computed(() =>
    assay.value && cohort.value ? patientUrls(assay.value, cohort.value) : null)

  async function configure(): Promise<void> {
    const res = await postToolConfig(config, (e) => {
      progress.value = e.current
      total.value = e.total_cases
    }, controller.signal)
    assay.value = res.assay
  }

  function failSession(e: unknown): void {
    if (isAbort(e) || controller.signal.aborted) return
    error.value = e as MyMriError
    status.value = 'error'
  }

  function repost(): Promise<void> {
    if (!reposting) {
      reposting = configure()
        .catch((e) => {
          // Without a working config nothing on the page can load.
          failSession(e)
          throw e
        })
        .finally(() => { reposting = null })
    }
    return reposting
  }

  /**
   * Run `fn`; on assay_not_loaded re-post the config once and retry `fn`
   * once. Failures of `fn` are rethrown for the caller to handle and never
   * touch the session state; only a failed re-post does.
   */
  async function withReload<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (first) {
      if ((first as MyMriError)?.code !== 'assay_not_loaded') throw first
    }
    await repost()
    return fn()
  }

  async function loadFindings(): Promise<FindingSummary[]> {
    const record = await withReload(async () => {
      try {
        return await fetchJson<FindingsRecord>(urls.value!.findings, controller.signal)
      } catch (e) {
        // An absent record means "no findings", not a failure.
        if ((e as MyMriError)?.code === 'no_findings') return null
        throw e
      }
    })
    return mapFindings(record)
  }

  // After unmount reload() is a no-op by design: the abort signal has fired, so every request rejects as an abort.
  async function reload(): Promise<void> {
    const mine = ++generation
    status.value = 'loading'
    error.value = null
    progress.value = 0
    total.value = 0
    findings.value = []
    try {
      await repost()
      const loaded = await loadFindings()
      if (mine !== generation) return
      findings.value = loaded
      status.value = 'ready'
    } catch (e) {
      if (mine === generation) failSession(e)
    }
  }

  onBeforeUnmount(() => controller.abort())
  void reload()

  return { status, progress, total, error, cohort, urls, findings, reload, withReload }
}
