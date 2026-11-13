import { computed, onBeforeUnmount, ref } from 'vue'
import { fetchJson, isAbort, patientUrls, postToolConfig } from '@/myMri/api'
import type { MyMriError } from '@/myMri/api'
import { getToolConfig } from '@/myMri/config'

export interface FindingSummary { label: string, channel: number, color: string }

interface FindingsRecord {
  findings?: { label: string, lesion: { channel: number, color: string } }[]
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

  function fail(e: unknown): void {
    if (isAbort(e) || controller.signal.aborted) return
    error.value = e as MyMriError
    status.value = 'error'
  }

  /** Run `fn`; on assay_not_loaded re-post the config once and retry once. */
  async function withReload<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (first) {
      if ((first as MyMriError)?.code !== 'assay_not_loaded') {
        fail(first)
        throw first
      }
    }
    try {
      await configure()
      return await fn()
    } catch (second) {
      fail(second)
      throw second
    }
  }

  async function loadFindings(): Promise<void> {
    const record = await withReload(async () => {
      try {
        return await fetchJson<FindingsRecord>(urls.value!.findings, controller.signal)
      } catch (e) {
        // An absent record means "no findings", not a failure.
        if ((e as MyMriError)?.code === 'no_findings') return null
        throw e
      }
    })
    findings.value = (record?.findings ?? []).map(f => ({
      label: f.label, channel: f.lesion.channel, color: f.lesion.color,
    }))
  }

  async function reload(): Promise<void> {
    status.value = 'loading'
    error.value = null
    progress.value = 0
    total.value = 0
    findings.value = []
    try {
      await configure()
      await loadFindings()
      status.value = 'ready'
    } catch (e) {
      // withReload records its own failures; this covers the initial configure().
      if (error.value === null) fail(e)
    }
  }

  onBeforeUnmount(() => controller.abort())
  void reload()

  return { status, progress, total, error, cohort, urls, findings, reload, withReload }
}
