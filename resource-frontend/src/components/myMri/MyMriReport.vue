<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import MyMriColumnHeader from '@/components/myMri/MyMriColumnHeader.vue'
import MyMriColumnState from '@/components/myMri/MyMriColumnState.vue'
import { MY_MRI_COPY } from '@/content/myMri'
import { fetchBlob, isAbort, toMyMriError } from '@/myMri/api'
import type { MyMriError } from '@/myMri/api'

const props = defineProps<{
  urlFor: (tz: string) => string
  cohort: string
  withReload: <T>(fn: () => Promise<T>) => Promise<T>
}>()

const status = ref<'loading' | 'ready' | 'error'>('loading')
const summary = ref('')
const objectUrl = ref<string | null>(null)
// Phones cannot show a blob PDF inline; only an explicit `false` switches to links.
const inline = computed(() => navigator.pdfViewerEnabled !== false)

let controller: AbortController | null = null

function release() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = null
}

function messageFor(e: MyMriError): string {
  return e.code === 'no_findings' ? MY_MRI_COPY.reportNoFindings : e.summary
}

/** Fetch the report on its own; the session and the 3D column are not involved. */
async function refetch(): Promise<void> {
  controller?.abort()
  const mine = new AbortController()
  controller = mine
  status.value = 'loading'
  release()
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const blob = await props.withReload(() => fetchBlob(props.urlFor(tz), mine.signal))
    if (mine.signal.aborted) return
    objectUrl.value = URL.createObjectURL(blob)
    status.value = 'ready'
  } catch (e) {
    if (isAbort(e) || mine.signal.aborted) return
    summary.value = messageFor(toMyMriError(e) as MyMriError)
    status.value = 'error'
  }
}

onBeforeUnmount(() => {
  controller?.abort()
  release()
})
void refetch()
defineExpose({ refetch })

// The report column only exists once the session is ready, so its state is the live one.
const linkClass = 'tw:rounded-card tw:border tw:border-border tw:px-3 tw:py-1 tw:text-body-sm tw:font-bold tw:text-text'
</script>

<template>
  <div class="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
    <MyMriColumnHeader :title="MY_MRI_COPY.reportHeading">
      <a v-if="objectUrl" :href="objectUrl" :download="`${cohort}-mri-report.pdf`" :class="linkClass">
        {{ MY_MRI_COPY.reportDownload }}
      </a>
    </MyMriColumnHeader>
    <MyMriColumnState :status="status" :summary="summary" :progress-text="MY_MRI_COPY.reportLoading" live @retry="refetch()">
      <iframe
        v-if="inline && objectUrl"
        :src="objectUrl"
        :title="MY_MRI_COPY.reportTitle"
        class="tw:h-full tw:min-h-96 tw:w-full tw:border-0 tw:bg-white"
      />
      <div v-else-if="objectUrl" class="tw:p-4">
        <a :href="objectUrl" target="_blank" rel="noopener" :class="linkClass">{{ MY_MRI_COPY.reportOpen }}</a>
      </div>
    </MyMriColumnState>
  </div>
</template>
