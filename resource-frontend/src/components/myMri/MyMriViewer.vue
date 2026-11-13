<script setup lang="ts">
import { ref } from 'vue'
import { MY_MRI_COPY } from '@/content/myMri'
import { meshColour, useMyMriScene } from '@/myMri/useMyMriScene'
import type { FindingSummary } from '@/myMri/useMyMriSession'

/**
 * The 3D column: the MRI's three planes with the marked areas over them, a
 * colour key, a controls hint and Reset.
 *
 * A load failure shows over the canvas, never as a blank stage, with a Try
 * again of its own: it emits `retry`, and the page rebuilds this viewer alone.
 * A scan with no marked areas is not a failure: the planes show with a note.
 */
const props = defineProps<{
  mri: string
  mask: string
  findings: FindingSummary[]
}>()
defineEmits<{ retry: [] }>()

const host = ref<HTMLElement | null>(null)
// Read once: a different scan is a different viewer (the page keys it by URL).
const { status, error, noMask, resetView } = useMyMriScene(host, {
  mri: props.mri,
  mask: props.mask,
  findings: props.findings,
})
</script>

<template>
  <div class="tw:relative tw:h-full tw:min-h-72 tw:overflow-hidden tw:rounded-b-card">
    <!-- Always mounted: the renderer is built into this element once. -->
    <div ref="host" class="tw:absolute tw:inset-0" role="img" :aria-label="MY_MRI_COPY.viewerLabel" />

    <div
      v-if="status === 'error'"
      role="alert"
      class="tw:absolute tw:inset-0 tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-3 tw:bg-surface-sunken tw:p-4
             tw:text-center tw:text-body-sm tw:text-text"
    >
      <p>{{ error }}</p>
      <button type="button" class="tw:rounded-card tw:border tw:border-border tw:px-3 tw:py-1 tw:font-bold tw:text-text" @click="$emit('retry')">
        {{ MY_MRI_COPY.tryAgain }}
      </button>
    </div>

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

      <!-- One row, so a long note and the hint share the width instead of
           overlapping. Not interactive: drags over it still reach the canvas. -->
      <div class="tw:pointer-events-none tw:absolute tw:inset-x-3 tw:bottom-3 tw:flex tw:items-end tw:gap-2">
        <p
          v-if="noMask"
          role="status"
          class="tw:pane tw:min-w-0 tw:rounded-card tw:px-3 tw:py-2 tw:text-caption tw:text-text-muted"
        >
          {{ MY_MRI_COPY.viewerNoMask }}
        </p>
        <ul
          v-else-if="props.findings.length"
          :aria-label="MY_MRI_COPY.viewerLegendLabel"
          class="tw:pane tw:flex tw:min-w-0 tw:flex-col tw:gap-1 tw:rounded-card tw:px-3 tw:py-2 tw:text-caption tw:text-text"
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
        <p class="tw:pane tw:ml-auto tw:shrink-0 tw:rounded-card tw:px-3 tw:py-1 tw:text-caption tw:text-text-muted">
          {{ MY_MRI_COPY.viewerHint }}
        </p>
      </div>
    </template>
  </div>
</template>
