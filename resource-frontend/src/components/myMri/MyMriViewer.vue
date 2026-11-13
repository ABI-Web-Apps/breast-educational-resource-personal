<script setup lang="ts">
import { ref, watch } from 'vue'
import { MY_MRI_COPY } from '@/content/myMri'
import { meshColour, useMyMriScene } from '@/myMri/useMyMriScene'
import type { FindingSummary } from '@/myMri/useMyMriSession'

/**
 * The 3D column: the MRI's three planes with the marked areas over them, a
 * colour key, a controls hint and Reset.
 *
 * A load failure is emitted as `error` so the page can show it in the column
 * with its Try again; the in-viewer message below is what shows if nothing
 * replaces the viewer, so the stage is never a blank canvas.
 */
const props = defineProps<{
  mri: string
  mask: string
  findings: FindingSummary[]
}>()
const emit = defineEmits<{ error: [message: string] }>()

const host = ref<HTMLElement | null>(null)
// Read once: a different scan is a different viewer (the page keys it by URL).
const { status, error, resetView } = useMyMriScene(host, {
  mri: props.mri,
  mask: props.mask,
  findings: props.findings,
})

watch(error, (message) => {
  if (message) emit('error', message)
})
</script>

<template>
  <div class="tw:relative tw:h-full tw:min-h-72 tw:overflow-hidden">
    <!-- Always mounted: the renderer is built into this element once. -->
    <div ref="host" class="tw:absolute tw:inset-0" role="img" :aria-label="MY_MRI_COPY.viewerLabel" />

    <p
      v-if="status === 'error'"
      role="alert"
      class="tw:absolute tw:inset-0 tw:flex tw:items-center tw:justify-center tw:bg-surface-sunken tw:p-4 tw:text-center tw:text-body-sm tw:text-text"
    >
      {{ error }}
    </p>

    <template v-else>
      <div
        v-if="status === 'loading'"
        class="tw:pointer-events-none tw:absolute tw:inset-0 tw:flex tw:items-center tw:justify-center"
      >
        <div class="tw:pane tw:flex tw:items-center tw:gap-3 tw:rounded-card tw:px-4 tw:py-3 tw:text-text" role="status">
          <span
            class="tw:size-4 tw:animate-spin tw:rounded-full tw:border-2 tw:border-current tw:border-t-transparent"
            aria-hidden="true"
          />
          <span class="tw:text-body-sm">{{ MY_MRI_COPY.loading }}</span>
        </div>
      </div>

      <button
        type="button"
        class="tw:pane tw:absolute tw:top-3 tw:right-3 tw:flex tw:min-h-11 tw:items-center tw:gap-1.5 tw:rounded-ctl tw:px-3
               tw:text-body-sm tw:text-text tw:disabled:opacity-50"
        :aria-label="MY_MRI_COPY.viewerResetLabel"
        :disabled="status !== 'ready'"
        @click="resetView()"
      >
        <svg viewBox="0 0 24 24" class="tw:size-4" aria-hidden="true">
          <path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7" />
        </svg>
        <span>{{ MY_MRI_COPY.viewerReset }}</span>
      </button>

      <ul
        v-if="props.findings.length"
        :aria-label="MY_MRI_COPY.viewerLegendLabel"
        class="tw:pane tw:absolute tw:bottom-3 tw:left-3 tw:flex tw:flex-col tw:gap-1 tw:rounded-card tw:px-3 tw:py-2
               tw:text-caption tw:text-text"
      >
        <li v-for="finding in props.findings" :key="finding.channel" class="tw:flex tw:items-center tw:gap-2">
          <span
            class="tw:size-3 tw:shrink-0 tw:rounded-full"
            :style="{ backgroundColor: meshColour(finding.color) }"
            aria-hidden="true"
          />
          {{ finding.label }}
        </li>
      </ul>

      <p class="tw:pane tw:absolute tw:bottom-3 tw:right-3 tw:rounded-card tw:px-3 tw:py-1 tw:text-caption tw:text-text-muted">
        {{ MY_MRI_COPY.viewerHint }}
      </p>
    </template>
  </div>
</template>
