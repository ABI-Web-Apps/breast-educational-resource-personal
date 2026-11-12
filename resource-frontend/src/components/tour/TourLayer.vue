<script setup lang="ts">
import { computed, nextTick, onErrorCaptured, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useViewerStore } from '@/stores/viewer'
import { useTourStore } from '@/stores/tour'
import { useTourDirector } from '@/composables/useTourDirector'
import { useAppRouter, usePageRoute } from '@/navigation/router'
import TourCard from '@/components/tour/TourCard.vue'
import TourRail from '@/components/tour/TourRail.vue'
import TourSpotlight from '@/components/tour/TourSpotlight.vue'

import { getCase } from '@/content/cases'
import { TOUR_CHAPTERS } from '@/content/tour'
import type { ChapterId, TourStep } from '@/content/tourTypes'
// PanelId lives in content/types, not tourTypes -- tourTypes imports it but
// does not re-export it.
import type { PanelId } from '@/content/types'
// In modules of their own so each rule can be unit-tested without mounting
// this component.
import { decideTourKeydown } from '@/utils/tourKeydown'
import { tourStepBody } from '@/utils/tourBodyText'
import { tourDwellMs } from '@/utils/tourDwell'

/**
 * The tour's one stateful component.
 *
 * Owns the target measurement (a rect that has to follow scroll, resize and
 * the app's own layout changes) and drives the director. Everything visual
 * is delegated to the three presentational children.
 */
const store = useTourStore()
const viewer = useViewerStore()
const route = usePageRoute()
const { navigateTo } = useAppRouter()

const props = defineProps<{
  /** Expands the tablet-only bottom sheet. That state is deliberately local
   *  to the layout (not the store -- see stores/viewer.ts's `contentOpen`
   *  comment), so the layout passes its setter down the same way it takes
   *  `startTour` back up via a template ref. Optional so a host with no
   *  sheet concept needs nothing. */
  expandSheet?: () => void
}>()

const director = useTourDirector({
  navigate: async (path) => { await navigateTo(path) },
  focusPanel: (panel: PanelId) => { void focusPanelByRoute(panel) },
  openSidebar: () => { viewer.sidebarOpen = true },
  closeSidebar: () => { viewer.sidebarOpen = false },
  isSidebarOpen: () => viewer.sidebarOpen,
  // xl+'s content column (its own `contentOpen`) and tablet's bottom sheet
  // (the layout-local prop above) are two different mechanisms for the same
  // "make the description visible" intent -- see I3 in the review this fix
  // came from. Both run; each is a no-op on the tier it doesn't apply to.
  expandSheet: () => { viewer.contentOpen = true; props.expandSheet?.() },
  currentRoute: () => route.value.path,
})

/**
 * Focus a slot the way the app itself does: by navigating to the modality
 * that slot is showing. Synthesising a pointerdown on the panel worked but
 * depended on CasePanels keeping that exact listener; the URL is the real
 * contract -- it always names the focused modality.
 */
async function focusPanelByRoute(panel: PanelId) {
  const slug = String(route.value.params.slug ?? '')
  const c = getCase(slug)
  const target = c?.panels.find(p => p.id === panel)?.modalities[0]
  if (target) await navigateTo(`/${slug}/${target.id}`)
}

const step = computed(() => director.currentStep.value)
const rect = ref<DOMRect | null>(null)
const targetEl = shallowRef<HTMLElement | null>(null)
/** The overlay's own root, read by the fail-safe in the step watcher. */
const layerEl = shallowRef<HTMLElement | null>(null)

function measure() {
  rect.value = targetEl.value?.getBoundingClientRect() ?? null
}

/**
 * Marks the focused region so the CSS in tokens.css can dim the rest, and
 * makes every dimmed region `inert` -- opacity alone still leaves its text
 * in the accessibility tree at a contrast ratio that only ever passed at
 * full opacity, and still leaves it in the tab order behind the tour's own
 * dialog. `inert` removes both, which is exactly what "dimmed" is meant to
 * communicate.
 */
function paintRegions() {
  const regions = [...document.querySelectorAll<HTMLElement>('[data-tour-region]')]

  // A region is focused if it IS the target, CONTAINS the target (a step
  // targeting one control inside a larger region), or is CONTAINED BY the
  // target (a step like `panels-wide` that targets the parent wrapping
  // several regions -- without this branch none of them ever matched and
  // all three dimmed while the copy described looking across them).
  const focused = regions.filter(el => Boolean(targetEl.value && (
    el === targetEl.value || el.contains(targetEl.value) || targetEl.value.contains(el)
  )))

  /*
   * Never dim everything.
   *
   * If no region matched, dimming the whole app tells the reader nothing --
   * it just hides the thing the card is pointing at behind 30% opacity, and
   * (because dimmed regions are also `inert`) makes the app unusable while
   * the tour looks broken. That is not hypothetical: two steps shipped
   * targeting elements that sat outside every region -- the case heading and
   * the one-up tab strip -- and both blacked the app out. Those two now
   * carry `data-tour-region`, but this is the guard that stops the next one
   * doing it again, because a target moving out from under its region is
   * invisible to every unit test in the repo.
   *
   * Expressed as a BODY-level flag, not by marking every region focused.
   * Marking them all focused would have been fewer lines and was wrong:
   * `data-tour-focus` means "this region IS the target", and the transient
   * no-target window a navigating step passes through would then have
   * claimed every region as the target of a step that has not arrived yet --
   * the same stale-paint bug the pre-paint guard below exists to prevent,
   * reached from the other side. TourLayer.test.ts catches exactly that.
   */
  const dimOthers = focused.length > 0
  document.body.toggleAttribute('data-tour-nodim', !dimOthers)

  for (const el of regions) {
    const isFocus = focused.includes(el)
    el.toggleAttribute('data-tour-focus', isFocus)
    el.inert = dimOthers && !isFocus
  }
}

/**
 * Auto-advance dwell timer. Armed only once `runStep` has resolved for the
 * CURRENT step (`dwellReady`) -- a demo still running must not be cut off --
 * and only while `store.playing`. `dwellToken`/`dwellStep` are snapshotted
 * alongside `dwellReady` so a resume (the `store.playing` watcher below)
 * schedules against the step that actually finished, not whatever `step`
 * has drifted to since.
 */
let dwellTimer: ReturnType<typeof setTimeout> | null = null
let dwellReady = false
let dwellToken = -1
let dwellStep: TourStep | undefined

function clearDwellTimer() {
  if (dwellTimer === null) return
  clearTimeout(dwellTimer)
  dwellTimer = null
}

function scheduleDwell() {
  clearDwellTimer()
  if (!store.playing || !dwellReady || !dwellStep || store.atEnd) return
  const token = dwellToken
  const body = tourStepBody(store.phase, dwellStep)
  dwellTimer = setTimeout(() => {
    dwellTimer = null
    if (token !== store.runToken || !store.active || !store.playing) return
    store.next()
  }, tourDwellMs(body))
}

/**
 * The other half of the same guarantee as the fail-safe below: if any of the
 * three overlay components throws while rendering, take the app out of
 * theatre mode rather than leaving it dimmed and inert around a card that
 * does not exist. Returning false lets the error still reach the app's own
 * handler and the console -- this suppresses the consequence, not the report.
 */
onErrorCaptured(() => {
  if (store.active) {
    clearTheatre()
    store.exit()
  }
  return false
})

/** Undo theatre mode: no dimming, nothing inert, nothing measured. */
function clearTheatre() {
  document.body.removeAttribute('data-tour-active')
  document.body.removeAttribute('data-tour-nodim')
  for (const el of document.querySelectorAll<HTMLElement>('[data-tour-region]')) {
    el.removeAttribute('data-tour-focus')
    el.inert = false
  }
  targetEl.value = null
  rect.value = null
}

watch([() => store.active, () => store.stepIndex], async () => {
  clearDwellTimer()
  dwellReady = false
  if (!store.active) {
    clearTheatre()
    return
  }
  document.body.setAttribute('data-tour-active', '')
  const s = step.value
  if (!s) return

  /*
   * Fail-safe: this function dims and `inert`s the whole app BEFORE the
   * overlay that explains why has rendered. If the overlay never arrives,
   * the reader is left in an unusable, greyed-out app with no card, no rail
   * and no visible way out -- which is exactly what the deployed build did.
   * Leaving the tour unopened is a bad outcome; leaving the app bricked is a
   * much worse one, so check and back out.
   *
   * Asks whether the LAYER ROOT has any child element, not whether a
   * specific `[data-tour-card]` exists: that catches any of the three
   * children failing rather than one. It reads the root through this
   * component's own template ref rather than `document.querySelector`,
   * because the first version did the latter and had a hole exactly where
   * it mattered -- when the root itself never mounted the query returned
   * null, the `layer && ...` guard fell through, and the app stayed in
   * theatre mode with no card. A ref is null in precisely one case (not
   * mounted), which is the case that has to bail.
   *
   * Two ticks, not one: the watcher runs pre-render, so the first gets past
   * this component's own re-render and the second past the children's.
   */
  await nextTick()
  await nextTick()
  if (!store.active) return
  if (!layerEl.value || layerEl.value.childElementCount === 0) {
    clearTheatre()
    store.exit()
    return
  }

  // Guards against a second Next/Back arriving while this step's demo is
  // still running (the rotate step's orbit alone is 2500ms): without this,
  // the older step's tail could overwrite the newer step's target after the
  // reader has already moved on, or after the tour has already exited.
  const token = store.runToken

  // Paint first, so the halo and the dimming match the card that is already
  // on screen -- otherwise the spotlight rings the PREVIOUS step's target
  // for as long as this step's demo takes to run (2500ms for the rotate
  // step), while the card and the demo both already point at the new one.
  // Best effort: runStep may navigate or run prepare actions that change
  // the DOM first, so resolveTarget can legitimately miss here. The pass
  // after runStep is still the authoritative one.
  //
  // A step whose route differs from where we are now is about to navigate
  // away -- resolving its selector here would hit whatever element on THIS
  // (soon-to-be-unmounted) page happens to match, which is only harmless by
  // coincidence when every case shares the same panel grid. Clear instead
  // and let the post-runStep pass, run after the navigation lands, be the
  // only one that paints.
  await nextTick()
  targetEl.value = (s.route && s.route !== route.value.path) ? null : director.resolveTarget(s)
  paintRegions()
  measure()

  await director.runStep(s)
  if (token !== store.runToken || !store.active) return
  await nextTick()
  targetEl.value = director.resolveTarget(s)
  paintRegions()
  measure()
  targetEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

  // Only now -- the demo (if any) has actually finished -- does the dwell
  // clock for auto-advance start.
  dwellReady = true
  dwellToken = token
  dwellStep = s
  scheduleDwell()
}, { immediate: true })

/** Toggling play/pause mid-step arms or disarms the dwell timer without
 *  waiting for the next step change. */
watch(() => store.playing, (playing) => {
  if (playing) scheduleDwell()
  else clearDwellTimer()
})

/** Focus returns to whatever opened the tour, like any modal. */
let opener: HTMLElement | null = null

watch(() => store.active, async (active) => {
  if (active) {
    opener = document.activeElement as HTMLElement | null
    await nextTick()
    document.querySelector<HTMLElement>('[data-tour-card]')?.focus()
  }
  else {
    opener?.focus()
    opener = null
  }
})

/** The `rotate` step invites the reader to grab the model -- advancing out
 *  from under a mid-drag reader would be rude, so touching any stage panel
 *  pauses auto-advance the same as a manual Next/Back. */
function onStagePointerDown(event: PointerEvent) {
  if (!store.active) return
  if ((event.target as HTMLElement | null)?.closest('[data-stage-panel]')) store.pause()
}

let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(measure)
  observer.observe(document.documentElement)
  addEventListener('scroll', measure, true)
  addEventListener('keydown', onKeydown)
  addEventListener('pointerdown', onStagePointerDown)
})
onScopeDispose(() => {
  observer?.disconnect()
  removeEventListener('scroll', measure, true)
  removeEventListener('keydown', onKeydown)
  removeEventListener('pointerdown', onStagePointerDown)
  clearDwellTimer()
  // The theatre attributes live on <body>, which outlives this component --
  // in plugin mode it is the portal's, and the next mount of the plugin
  // would otherwise open already dimmed.
  clearTheatre()
})

function onKeydown(event: KeyboardEvent) {
  if (!store.active) return
  const action = decideTourKeydown(event)
  if (action === 'exit') void director.exitTour()
  else if (action === 'next') advance()
  else if (action === 'back') goBack()
}

/**
 * Design doc §4.4: exiting is like closing a modal and returns you to where
 * you started; FINISHING does not. The last step has just said "pressing
 * Next is enough to walk the whole resource", so bouncing the reader back
 * would contradict it.
 *
 * Manual Next is "manual intent" (WCAG 2.2.2's pause trigger): it stops
 * auto-advance the same as pressing the play/pause control would.
 */
function advance() {
  store.pause()
  if (store.atEnd) director.finishTour()
  else store.next()
}

function goBack() {
  store.pause()
  store.back()
}

function onChapter(id: ChapterId) {
  const index = director.steps.value.findIndex(s => s.chapter === id)
  if (index >= 0) store.goToStep(index)
}

const activeChapter = computed<ChapterId>(() => step.value?.chapter ?? 'layout')
const chapterLabel = computed(
  () => TOUR_CHAPTERS.find(c => c.id === activeChapter.value)?.label ?? '',
)
const bodyText = computed(() => tourStepBody(store.phase, step.value))

// Exposed so the layout can start the tour without owning the director or
// any tour state itself -- both the header button and the launcher route
// through this.
defineExpose({ startTour: director.startTour })
</script>

<template>
  <!--
    A STABLE ROOT ELEMENT, and it is not decoration.

    This component's root used to be the `<template v-if>` below, so its own
    subtree alternated between a comment vnode and a fragment. An
    always-present root can never have a null `el`, which is what the step
    watcher's fail-safe reads back through `layerEl`. `display: contents`
    means it generates no box at all, so it changes no layout: all three
    children position themselves against the viewport anyway.

    The other half of the fix is the `v-if` in DefaultLayout.vue, which
    mounts this component only after the layout itself has mounted.
  -->
  <div ref="layerEl" data-tour-layer class="tw:contents">
    <template v-if="store.active && step">
      <TourSpotlight :rect="rect" :step-id="step.id" />
      <TourCard
        :title="step.title"
        :body="bodyText"
        :step-number="store.stepIndex + 1"
        :step-count="store.stepCount"
        :chapter-label="chapterLabel"
        :at-end="store.atEnd"
        :rect="rect"
        :placement="step.placement ?? 'bottom'"
        @next="advance"
        @back="goBack"
        @exit="director.exitTour()"
      />
      <TourRail
        :chapters="TOUR_CHAPTERS"
        :active-chapter="activeChapter"
        :step-index="store.stepIndex"
        :step-count="store.stepCount"
        :at-end="store.atEnd"
        :playing="store.playing"
        @next="advance"
        @back="goBack"
        @exit="director.exitTour()"
        @chapter="onChapter"
        @toggle-playing="store.togglePlaying()"
      />
    </template>
  </div>
</template>
