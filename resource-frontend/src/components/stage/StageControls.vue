<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
/**
 * Design doc §10.1's control bar: `⟲ Reset  ⛶ Fullscreen  ⌖ Locate lesion
 * ... 62/104`. Rendered by `CopperStage` itself, directly under its own
 * canvas -- one bar per stage, since three-up puts up to three stages on
 * screen at once and each needs its own.
 *
 * Deliberately presentational: everything it knows arrives as props and
 * everything it does (except fullscreen, which is pure DOM) leaves as an
 * event. That keeps the 3D wiring in one place and lets this file be tested
 * without a renderer.
 */
const props = defineProps<{
  /** Live slice number. 0/0 when the modality has no slices (Anatomy, and
   * the 2D ultrasound). */
  sliceIndex: number
  sliceMax: number
  /** The value to announce -- only changes once a scrub settles. */
  settledSliceIndex: number
  /** The case's lesion slice, or 0 when it has none. §7.2 shows the locate
   * control only for the five cases that actually have a lesion. */
  lesionSliceIndex: number
  /** False until the stage's renderer exists; the buttons do nothing until
   * then, so they say so rather than silently no-opping. */
  ready: boolean
  /** Three-up: icon-only buttons, since three bars share the width one had.
   * Every button keeps its `aria-label`, so nothing is lost for a screen
   * reader -- only the visible text goes. */
  compact?: boolean
}>()

const emit = defineEmits<{
  reset: []
  locate: []
}>()

const hasSlices = computed(() => props.sliceMax > 0)
const hasLesion = computed(() => props.lesionSliceIndex > 0 && hasSlices.value)

/**
 * The element fullscreen targets: this panel (canvas host + this bar),
 * marked `data-stage-panel` by `CopperStage`. Fullscreening the canvas alone
 * would take this bar off screen with it, leaving Esc as the only way back
 * out.
 */
const root = ref<HTMLElement>()
const isFullscreen = ref(false)

function syncFullscreen() {
  isFullscreen.value = Boolean(typeof document !== 'undefined' && document.fullscreenElement)
}

async function onFullscreen() {
  if (typeof document === 'undefined') return
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {})
    return
  }
  // Prefers this panel; falls back to the whole stage column for any caller
  // that is not inside a panel. In three-up, fullscreening the column would
  // blow up all three panels when the reader asked for one.
  const target = root.value?.closest<HTMLElement>('[data-stage-panel]')
    ?? root.value?.closest<HTMLElement>('[data-stage-column]')
    ?? root.value?.parentElement
  // Safari and any browser with the Fullscreen API blocked by permissions
  // policy reject this; there is nothing to recover, and an unhandled
  // rejection here would surface as a dev-overlay error on a decorative
  // control.
  await target?.requestFullscreen?.().catch(() => {})
}

onMounted(() => {
  syncFullscreen()
  document.addEventListener('fullscreenchange', syncFullscreen)
})
onScopeDispose(() => {
  // Guarded for a non-browser environment, where there is no document.
  if (typeof document !== 'undefined') {
    document.removeEventListener('fullscreenchange', syncFullscreen)
  }
})

/** Shared by all three buttons. `min-h-11` is §11's 44px touch-target
 * floor; `hover:bg-current/10` tints from the bar's own foreground colour.
 * `group` and `relative` are what the tooltip below hangs off. */
const buttonClass = 'tw:group tw:relative tw:flex tw:min-h-11 tw:items-center tw:gap-1.5 tw:rounded-ctl tw:px-3 tw:text-body-sm '
  + 'tw:hover:bg-current/10 tw:disabled:opacity-50 tw:disabled:hover:bg-transparent'

/**
 * The tooltip shown for an icon-only button.
 *
 * Compact mode hides the labels, and the browser's own `title` bubble is
 * not an answer: it is unstyled, appears after a delay the app does not
 * control, and looks nothing like the rest of the interface.
 *
 * CSS only -- no timers, no positioning library. It sits above the button
 * because this bar is at the foot of a panel, and it is
 * `pointer-events-none` so it can never eat the click it is describing.
 * `group-focus-visible` matters as much as `group-hover`: a keyboard
 * reader gets the same hint, and it is the same accessible name the button
 * already carries via `aria-label`.
 */
const tipClass = 'tw:pointer-events-none tw:absolute tw:bottom-full tw:left-1/2 tw:z-10 tw:mb-2 tw:-translate-x-1/2 '
  + 'tw:whitespace-nowrap tw:rounded-ctl tw:bg-text tw:px-2 tw:py-1 tw:text-caption tw:font-medium tw:text-surface '
  + 'tw:opacity-0 tw:shadow-md tw:transition-opacity tw:duration-100 '
  + 'tw:group-hover:opacity-100 tw:group-focus-visible:opacity-100'
</script>

<template>
  <div
    ref="root"
    data-tour="stage-controls"
    class="tw:flex tw:shrink-0 tw:flex-wrap tw:items-center tw:gap-2 tw:border-t tw:border-border
           tw:bg-surface tw:px-4 tw:py-2 tw:text-text"
  >
    <button
      type="button"
      :class="buttonClass"
      :disabled="!props.ready"
      aria-label="Reset view"
      @click="emit('reset')"
    >
      <svg viewBox="0 0 24 24" class="tw:size-4" aria-hidden="true">
        <path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7" />
      </svg>
      <span v-if="!props.compact">Reset view</span>
      <span v-else :class="tipClass" aria-hidden="true">Reset view</span>
    </button>

    <button
      type="button"
      :class="buttonClass"
      :aria-pressed="isFullscreen"
      :aria-label="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
      @click="onFullscreen"
    >
      <svg viewBox="0 0 24 24" class="tw:size-4" aria-hidden="true">
        <!--
          Two glyphs, not one.

          The label used to carry the state ("Fullscreen" / "Exit
          fullscreen"), but compact mode hides labels, so in three-up the
          button looked identical in both states and gave the reader nothing
          to go on. Corners pointing OUT means "expand"; corners pointing IN
          means "collapse" -- the same convention video players use, and
          legible at 16px without a label beside it.
        -->
        <path
          v-if="isFullscreen"
          fill="currentColor"
          d="M3 8h5V3H6v3H3zm13-5v3h3v2h-5V3zM3 16h5v5H6v-3H3zm13 5v-3h3v-2h-5v5z"
        />
        <path
          v-else
          fill="currentColor"
          d="M5 5h5V3H3v7h2zm14 0v5h2V3h-7v2zM5 19v-5H3v7h7v-2zm14 0h-5v2h7v-7h-2z"
        />
      </svg>
      <span v-if="!props.compact">{{ isFullscreen ? 'Exit fullscreen' : 'Fullscreen' }}</span>
      <span v-else :class="tipClass" aria-hidden="true">
        {{ isFullscreen ? 'Exit fullscreen' : 'Fullscreen' }}
      </span>
    </button>

    <button
      v-if="hasLesion"
      type="button"
      data-tour="locate-lesion"
      :class="`${buttonClass} tw:font-bold tw:text-brand-hover tw:hover:bg-brand/10`"
      :disabled="!props.ready"
      aria-label="Locate lesion"
      @click="emit('locate')"
    >
      <svg viewBox="0 0 24 24" class="tw:size-4" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8m0-6v3m0 14v3M2 12h3m14 0h3"
        />
      </svg>
      <span v-if="!props.compact">Locate lesion</span>
      <span v-else :class="tipClass" aria-hidden="true">Locate lesion</span>
    </button>

    <!--
      Two nodes for one number, on purpose (controller correction C11). The
      visible one updates on every frame of an eased scrub, which is right
      for the eye and catastrophic for a screen reader: an `aria-live` region
      bound to it queues one utterance per frame. The live region instead
      carries `settledSliceIndex`, which changes only when the scrub stops.
      `tabular-nums` is design doc §7.5's own requirement -- without it the
      readout's width jitters as the digits change.

      Compact (three-up, icon-only buttons) drops the "Slice " prefix so
      three narrow bars can each still fit their own readout.
    -->
    <p
      v-if="hasSlices"
      class="tw:ml-auto tw:text-body-sm tw:tabular-nums tw:opacity-80"
      aria-hidden="true"
    >
      <template v-if="props.compact">{{ props.sliceIndex }} / {{ props.sliceMax }}</template>
      <template v-else>Slice {{ props.sliceIndex }} / {{ props.sliceMax }}</template>
    </p>
    <span v-if="hasSlices" class="tw:sr-only" role="status" aria-live="polite">
      Slice {{ props.settledSliceIndex }} of {{ props.sliceMax }}
    </span>
  </div>
</template>
