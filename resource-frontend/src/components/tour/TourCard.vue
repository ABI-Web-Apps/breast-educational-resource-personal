<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'

const props = defineProps<{
  title: string
  body: string
  stepNumber: number
  stepCount: number
  chapterLabel: string
  atEnd: boolean
  /** Null for a centred step with no target. */
  rect: DOMRect | null
  placement: 'top' | 'bottom' | 'left' | 'right' | 'center'
}>()

const emit = defineEmits<{ next: [], back: [], exit: [] }>()

const titleId = `tour-card-title-${Math.random().toString(36).slice(2, 8)}`

const GAP = 16
/** The chapter rail is `fixed bottom-6` and about 60px tall, so anything
 *  anchored to the bottom has to clear it or it eats the card's own
 *  buttons. */
const RAIL_CLEARANCE = 96

/**
 * The card's own footprint, measured rather than guessed.
 *
 * Fix round 1 (Task 9): a target rect spanning nearly the full viewport
 * (chapter 2's `panels-wide` step) put a `bottom`-placement card's `top`
 * at or past the viewport's bottom edge -- the card rendered entirely
 * off-screen, Next included, with no keyboard-free way to reach it. GAP and
 * RAIL_CLEARANCE alone guarded the anchor's OWN edge; nothing capped the
 * anchor against the card's OTHER edge, because that edge's position was
 * never known. This is the real number, not another guessed constant.
 */
const cardEl = ref<HTMLElement>()
const size = ref({ width: 0, height: 0 })
function measure() {
  if (cardEl.value) size.value = { width: cardEl.value.offsetWidth, height: cardEl.value.offsetHeight }
}
let observer: ResizeObserver | undefined
onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (cardEl.value) observer.observe(cardEl.value)
})
onScopeDispose(() => observer?.disconnect())

/** An anchor measured from the near edge (top/left): floored at `GAP` off
 *  that edge, and capped so the card's FAR edge stays `farClearance` clear
 *  of the opposite one. */
function clampNear(raw: number, farClearance: number, extent: number, cardSize: number): number {
  return Math.max(GAP, Math.min(raw, extent - farClearance - cardSize))
}
/** An anchor measured from the far edge (bottom/right): floored at
 *  `nearFloor` off that edge (GAP, or RAIL_CLEARANCE at the bottom), and
 *  capped so the card's NEAR edge stays clear of the opposite one. */
function clampFar(raw: number, nearFloor: number, extent: number, cardSize: number): number {
  return Math.max(nearFloor, Math.min(raw, extent - GAP - cardSize))
}

/**
 * Where the card sits.
 *
 * Anchored from whichever edge faces the target rather than guessing the
 * card's own height/width: `top` placement sets `bottom`, `left` placement
 * sets `right`, and so on. The browser positions from that edge, so no
 * height/width constant is needed and a taller card never grows through its
 * own target. `clampNear`/`clampFar` then cap each anchor against the
 * card's real, measured OTHER edge, so the whole box stays on screen
 * regardless of target geometry.
 */
const style = computed(() => {
  if (!props.rect || props.placement === 'center') {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  }
  const r = props.rect
  const vw = globalThis.innerWidth || 1024
  const vh = globalThis.innerHeight || 768
  const w = size.value.width
  const h = size.value.height

  // Cross-axis anchor: pick the side that puts the card's near edge flush
  // with the target's near edge, chosen by which half of the viewport the
  // target sits in. Same edge-anchoring trick as the main axis, so a wide
  // or tall card is still sized by the browser, not by a guessed constant.
  const hSide = (r.left + r.right) / 2 > vw / 2
    ? { right: `${clampFar(vw - r.right, GAP, vw, w)}px` }
    : { left: `${clampNear(r.left, GAP, vw, w)}px` }
  const vSide = (r.top + r.bottom) / 2 > vh / 2
    ? { bottom: `${clampFar(vh - r.bottom, RAIL_CLEARANCE, vh, h)}px` }
    : { top: `${clampNear(r.top, RAIL_CLEARANCE, vh, h)}px` }

  if (props.placement === 'right') {
    return { ...vSide, left: `${clampNear(r.right + GAP, GAP, vw, w)}px` }
  }
  if (props.placement === 'left') {
    return { ...vSide, right: `${clampFar(vw - r.left + GAP, GAP, vw, w)}px` }
  }
  if (props.placement === 'bottom') {
    return { top: `${clampNear(r.bottom + GAP, RAIL_CLEARANCE, vh, h)}px`, ...hSide }
  }
  // 'top': anchor the card's bottom edge above the target instead of its
  // top edge, so the card grows upward and never covers the target.
  return { bottom: `${clampFar(vh - r.top + GAP, RAIL_CLEARANCE, vh, h)}px`, ...hSide }
})

const btn = 'tw:flex tw:min-h-11 tw:items-center tw:rounded-full tw:px-4 tw:text-body-sm tw:font-bold'
</script>

<template>
  <div
    ref="cardEl"
    role="dialog"
    tabindex="-1"
    :aria-labelledby="titleId"
    data-tour-card
    class="hud-glass tw:fixed tw:z-50 tw:w-80 tw:max-w-[calc(100vw-2rem)] tw:max-h-[calc(100dvh-7rem)] tw:overflow-y-auto
           tw:rounded-card tw:p-5"
    :style="style"
  >
    <div class="tw:flex tw:items-center tw:justify-between tw:gap-2">
      <p class="tw:text-caption tw:font-bold tw:uppercase tw:tracking-[0.16em] tw:text-(--hud-accent)">
        {{ props.chapterLabel }}
      </p>
      <p class="tw:font-mono tw:text-caption tw:tabular-nums tw:text-(--hud-num)">
        {{ props.stepNumber }} / {{ props.stepCount }}
      </p>
    </div>
    <!-- aria-live: role="dialog" only announces on first focus, and
         stepping swaps this title/body with no re-focus -- without a live
         region, only the rail's separate "n / N" status is ever announced.
         "polite" so it queues behind that status rather than talking over
         it, avoiding a double announcement of the same step change. -->
    <div aria-live="polite">
      <h2 :id="titleId" class="tw:mt-1.5 tw:text-h2 tw:font-bold tw:tracking-tight tw:text-(--hud-ink)">
        {{ props.title }}
      </h2>
      <p class="tw:mt-2 tw:text-body-sm tw:leading-relaxed tw:text-(--hud-dim)">
        {{ props.body }}
      </p>
    </div>

    <div class="tw:mt-5 tw:flex tw:items-center tw:gap-2">
      <button
        type="button"
        data-tour-back
        :class="`${btn} tw:text-(--hud-dim) tw:hover:bg-white/5`"
        @click="emit('back')"
      >
        Back
      </button>
      <button
        type="button"
        data-tour-next
        :class="`${btn} tw:ml-auto tw:bg-(--hud-accent) tw:text-(--hud-base) tw:hover:opacity-90`"
        @click="emit('next')"
      >
        {{ props.atEnd ? 'Finish' : 'Next' }}
      </button>
      <button
        type="button"
        data-tour-exit
        aria-label="Close the guided tour"
        :class="`${btn} tw:text-(--hud-dim) tw:hover:bg-white/5`"
        @click="emit('exit')"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Dark glass: the inset top highlight is what reads as glass rather than a
   flat grey box (design doc T2). */
.hud-glass {
  background: var(--hud-glass);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid var(--hud-line);
  box-shadow: 0 16px 40px rgb(0 0 0 / .45), inset 0 1px 0 rgb(255 255 255 / .07);
}
</style>
