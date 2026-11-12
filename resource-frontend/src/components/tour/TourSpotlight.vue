<script setup lang="ts">
import { computed } from 'vue'

/**
 * The ROI reticle drawn over the current target.
 *
 * Four corner brackets, the way a radiologist marks a region of interest --
 * not a glowing box that smothers the edge it frames. Purely an overlay: it
 * never touches the target element, so nothing about the app's own layout,
 * stacking or canvas sizing changes while the tour runs. Positioning is
 * viewport-fixed because the rect handed in comes from getBoundingClientRect.
 *
 * No target-name label here -- TourCard's own heading already names the
 * step; a second label floating over the target duplicated it and read
 * ~2:1 on light content. The brackets now only point; the card names.
 */
const props = defineProps<{
  rect: DOMRect | null
  /** Keys the scan-line sweep so it replays once per STEP, not on every
   *  scroll/resize remeasurement of the same target's rect. */
  stepId?: string
}>()

const OFFSET = 6 // brackets float just outside the target rect
const OUTER_STROKE = 5 // dark stroke, drawn first -- shows as an edge on both sides of the accent stroke
const INNER_STROKE = 2.5 // accent stroke, drawn on top, inset inside the dark one

/** Arm length scales with the target so it reads at small sizes without
 *  swallowing large ones: 20% of the shorter side, clamped to [18, 44]px.
 *  Raised from the original [14, 28] band -- at panel size the old clamp
 *  capped every bracket at 28px, too small to read as a deliberate reticle. */
const armLen = computed(() => {
  if (!props.rect) return 22
  const short = Math.min(props.rect.width, props.rect.height)
  return Math.round(Math.min(44, Math.max(18, short * 0.2)))
})

/** Each corner's L-shaped path, vertex nearest the actual target corner --
 *  same two-side pairing the old border-width shorthand used (top+left for
 *  tl, and so on), just expressed as an SVG path instead of a box border. */
function bracketPath(name: 'tl' | 'tr' | 'bl' | 'br', len: number): string {
  switch (name) {
    case 'tl': return `M ${len} 0 L 0 0 L 0 ${len}`
    case 'tr': return `M 0 0 L ${len} 0 L ${len} ${len}`
    case 'bl': return `M ${len} ${len} L 0 ${len} L 0 0`
    case 'br': return `M 0 ${len} L ${len} ${len} L ${len} 0`
  }
}

const corners = computed(() => {
  const len = armLen.value
  return [
    { name: 'tl' as const, style: { top: `-${OFFSET}px`, left: `-${OFFSET}px` } },
    { name: 'tr' as const, style: { top: `-${OFFSET}px`, right: `-${OFFSET}px` } },
    { name: 'bl' as const, style: { bottom: `-${OFFSET}px`, left: `-${OFFSET}px` } },
    { name: 'br' as const, style: { bottom: `-${OFFSET}px`, right: `-${OFFSET}px` } },
  ].map(c => ({ ...c, d: bracketPath(c.name, len) }))
})
</script>

<template>
  <div
    v-if="props.rect"
    data-tour-halo
    aria-hidden="true"
    class="tw:pointer-events-none tw:fixed tw:z-40"
    :style="{
      top: `${props.rect.top}px`,
      left: `${props.rect.left}px`,
      width: `${props.rect.width}px`,
      height: `${props.rect.height}px`,
    }"
  >
    <!-- Two-tone stroke: a dark outer pass under a thinner accent pass on
         the same path, so the bracket keeps an edge against BOTH a near-
         black MRI slice and a white content panel -- a single accent-only
         stroke measures well under 3:1 on white; drop-shadow alone did not
         fix that either. Outer alpha raised to .82 (from .55) so it reads
         as a real dark ring rather than a translucent smudge; inner uses
         --hud-accent-strong, not --hud-accent -- see tokens.css for the
         measured contrast that made a deeper rose necessary here. -->
    <svg
      v-for="corner in corners"
      :key="corner.name"
      class="tw:absolute"
      :width="armLen"
      :height="armLen"
      :viewBox="`0 0 ${armLen} ${armLen}`"
      :style="corner.style"
    >
      <path :d="corner.d" fill="none" stroke="rgb(20 18 26 / .82)" :stroke-width="OUTER_STROKE" stroke-linecap="square" />
      <path :d="corner.d" fill="none" stroke="var(--hud-accent-strong)" :stroke-width="INNER_STROKE" stroke-linecap="square" />
    </svg>

    <!-- One top-to-bottom pass on open, not a loop -- motion-safe gated, and
         keyed to the step so scroll/resize remeasurement never replays it. -->
    <span
      :key="props.stepId"
      aria-hidden="true"
      class="tw:pointer-events-none tw:absolute tw:inset-x-0 tw:top-0 tw:h-0.5 tw:opacity-0 tw:motion-safe:animate-[tour-scan_3.6s_ease-out_1]"
      style="background: linear-gradient(90deg, transparent, var(--hud-accent), transparent);
             filter: drop-shadow(0 0 4px var(--hud-accent));"
    />
  </div>
</template>
