<script setup lang="ts">
import { computed } from 'vue'
import type { ChapterId, TourChapter } from '@/content/tourTypes'

const props = defineProps<{
  chapters: TourChapter[]
  activeChapter: ChapterId
  stepIndex: number
  stepCount: number
  atEnd: boolean
  /** Auto-advance on/off; the WCAG 2.2.2 pause control lives here. */
  playing: boolean
}>()

const emit = defineEmits<{
  next: [], back: [], exit: [], chapter: [ChapterId], 'toggle-playing': []
}>()

/** Zero-padded so the readout reads as an instrument, not a fraction. */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Overall progress (not just the active chapter) as a CSS length, drawn as
 *  the accent fill under the chapter ticks. */
const progressPct = computed(() => `${((props.stepIndex + 1) / props.stepCount) * 100}%`)

const quietBtn = 'tw:flex tw:size-11 tw:items-center tw:justify-center tw:rounded-full tw:text-(--hud-dim) tw:hover:bg-(--hud-line)'
</script>

<template>
  <!-- The chapter rail: a player's transport, not a progress bar. It is the
       one piece of chrome that says "this is a tour with chapters, and you
       are driving". -->
  <div
    data-tour-rail
    class="hud-glass tw:fixed tw:bottom-6 tw:left-1/2 tw:z-50 tw:flex tw:-translate-x-1/2 tw:items-center tw:gap-3
           tw:rounded-full tw:px-4 tw:py-2"
  >
    <!-- The play/pause control: filled and accented, the one thing on the
         rail that is not quiet -- it is the WCAG 2.2.2 control itself. -->
    <button
      type="button"
      data-tour-play
      :aria-label="props.playing ? 'Pause the guided tour' : 'Play the guided tour'"
      class="tw:flex tw:size-11 tw:items-center tw:justify-center tw:rounded-full tw:bg-(--hud-accent) tw:text-(--hud-base) tw:hover:opacity-90"
      @click="emit('toggle-playing')"
    >
      {{ props.playing ? '⏸' : '▶' }}
    </button>

    <button
      type="button"
      aria-label="Previous step"
      :class="quietBtn"
      @click="emit('back')"
    >
      ❮
    </button>

    <!-- Hairline track + accent fill, drawn as two stacked backgrounds on the
         list itself: the fill (drawn first) sits on top, sized to overall
         progress; the full-width track underneath is the hairline. Ticks are
         a big (44px) button around a small (6px) visible dot -- the same
         inner-span-plus-negative-margin trick the chapter segments always
         used, so the hit target survives while the mark stays a mark. -->
    <ol
      class="tw:flex tw:items-center tw:gap-4 tw:bg-left tw:bg-no-repeat"
      :style="{
        backgroundImage: `linear-gradient(var(--hud-accent), var(--hud-accent)), linear-gradient(var(--hud-line), var(--hud-line))`,
        backgroundSize: `${progressPct} 2px, 100% 1px`,
      }"
    >
      <li v-for="c in props.chapters" :key="c.id">
        <button
          type="button"
          :data-tour-chapter="c.id"
          :aria-current="c.id === props.activeChapter ? 'step' : undefined"
          :aria-label="`Chapter: ${c.label}`"
          class="tw:group tw:flex tw:min-h-11 tw:items-center tw:px-1 tw:-my-4"
          @click="emit('chapter', c.id)"
        >
          <span
            class="tw:size-1.5 tw:rounded-full tw:ring-2 tw:transition-colors"
            :style="{
              backgroundColor: c.id === props.activeChapter ? 'var(--hud-accent)' : 'var(--hud-dim)',
              '--tw-ring-color': 'var(--hud-base)',
            }"
          />
        </button>
      </li>
    </ol>

    <button
      type="button"
      :aria-label="props.atEnd ? 'Finish the guided tour' : 'Next step'"
      :class="quietBtn"
      @click="emit('next')"
    >
      {{ props.atEnd ? '✓' : '❯' }}
    </button>

    <p role="status" aria-live="polite" class="tw:font-mono tw:text-caption tw:tabular-nums tw:text-(--hud-num)">
      {{ pad(props.stepIndex + 1) }} / {{ pad(props.stepCount) }}
    </p>

    <button
      type="button"
      aria-label="Close the guided tour"
      :class="quietBtn"
      @click="emit('exit')"
    >
      ✕
    </button>
  </div>
</template>

<style scoped>
/* Same glass treatment as the card (design doc T2). */
.hud-glass {
  background: var(--hud-glass);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid var(--hud-line);
  box-shadow: 0 16px 40px rgb(0 0 0 / .45), inset 0 1px 0 rgb(255 255 255 / .07);
}
</style>
