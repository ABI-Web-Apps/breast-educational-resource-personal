import { getTourStage } from '@/composables/useTourStageBridge'
import type { Pose } from '@/composables/copperExtras'
import { tourSteps } from '@/content/tour'
import type { TourDemo, TourLayoutScope, TourStep } from '@/content/tourTypes'
import type { PanelId } from '@/content/types'
import { useTourStore } from '@/stores/tour'
import { computed, nextTick } from 'vue'

export interface TourDirectorDeps {
  navigate: (path: string) => Promise<void>
  focusPanel: (panel: PanelId) => void
  openSidebar: () => void
  closeSidebar: () => void
  /** Read back so the director can restore whatever the reader had before
   *  the tour touched it, instead of always forcing one state. */
  isSidebarOpen: () => boolean
  expandSheet: () => void
  currentRoute: () => string
  /** How long a stage may make no progress before the step degrades. */
  stallMs?: number
  /** Absolute ceiling on any single wait. */
  ceilingMs?: number
}

const DEG = Math.PI / 180

export function useTourDirector(deps: TourDirectorDeps) {
  const store = useTourStore()
  const stallMs = deps.stallMs ?? 10_000
  const ceilingMs = deps.ceilingMs ?? 60_000

  /** Poses captured before a demo, restored on step end or tour exit. */
  const captured = new Map<PanelId, Pose>()

  /**
   * Slice indices captured before a `scrubSlices` demo, restored the same way
   * and on the same schedule as `captured` above.
   *
   * This exists because the scrub demo used to do neither half of that. It
   * returned to `Math.round(max / 2)` -- an INVENTED index, not the reader's
   * -- and it did so after a staleness `return`, so any step that was
   * superseded mid-demo (auto-advance is enough; the dwell timer fires while
   * the scrub is still waiting) left the volume parked on its LAST slice. At
   * the last slice the plane sits far closer to the camera than at the
   * middle, so it renders much larger and spills outside the panel: the
   * "3D panel is deformed after the tour" report. Measured on a full tour
   * run -- the MRI came out of it reading 191/191 where a fresh load reads
   * 96/191, with the anatomy and mammogram panels pixel-identical.
   */
  const capturedSlices = new Map<PanelId, number>()

  /** Sidebar open/closed state as the reader had it before the tour's own
   *  `openSidebar`/`closeSidebar` prepare steps touched it. Captured once
   *  per run (startTour) and put back in restoreCaptured, so the drawer the
   *  tour opens for the case-list step never outlives the tour itself. */
  let sidebarOpenAtStart = false

  /**
   * First selector that matches wins; all missing (or all invisible) means
   * "skip this step".
   *
   * `querySelector` finds a match regardless of CSS visibility, so a
   * selector that also exists on a `display:none` element (e.g. a one-up
   * layout's non-focused panels) would otherwise win with an element that
   * can never be spotlighted -- `getBoundingClientRect` on it is
   * `DOMRect(0,0,0,0)`, which still passes TourSpotlight's `v-if="rect"`
   * and draws a halo at the viewport origin. `getClientRects().length` is
   * 0 exactly when an element (or an ancestor) is `display:none`, and >0 for
   * any element that is actually laid out, even a legitimately zero-sized
   * one -- so it is the right "is this a real target" check, not width/
   * height, which can't tell those two cases apart.
   */
  function resolveTarget(step: TourStep): HTMLElement | null {
    for (const selector of step.target ?? []) {
      const el = document.querySelector<HTMLElement>(selector)
      if (el && el.getClientRects().length > 0) return el
    }
    return null
  }

  /**
   * Wide or narrow, asked of CSS rather than of the window.
   *
   * One-up hides the non-focused panels with `display: none` (CasePanels'
   * container query), so a visible non-focused panel IS three-up. This is
   * the same technique CaseSidebar's drawer gate uses -- read back what CSS
   * already decided, never measure the viewport in JS.
   */
  function isWideLayout(): boolean {
    const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'))
    const unfocused = panels.filter(el => el.dataset.focused !== 'true')
    return unfocused.some(el => getComputedStyle(el).display !== 'none')
  }

  function layoutScope(): TourLayoutScope {
    return isWideLayout() ? 'wide' : 'narrow'
  }

  const steps = computed(() => tourSteps(store.layout))
  const currentStep = computed<TourStep | undefined>(() => steps.value[store.stepIndex])

  async function runPrepare(step: TourStep) {
    for (const action of step.prepare ?? []) {
      if (action.kind === 'openSidebar') deps.openSidebar()
      else if (action.kind === 'closeSidebar') deps.closeSidebar()
      else if (action.kind === 'expandSheet') deps.expandSheet()
      else deps.focusPanel(action.panel)
    }
    await nextTick()
  }

  /**
   * Waits for a stage, degrading rather than blocking.
   *
   * Not a fixed timeout: on GitHub Pages a 20-30MB volume routinely takes
   * longer than any timeout short enough to feel responsive. Returns false
   * once the stage has made no progress for `stallMs`, or `ceilingMs` has
   * passed outright -- the caller then shows the step's manual copy.
   */
  async function awaitStage(panel: PanelId, token: number): Promise<boolean> {
    const api = getTourStage(panel)
    if (!api) return false
    if (api.isFailed()) return false
    if (api.isReady()) return true

    store.phase = 'waiting'
    const began = Date.now()
    let lastChange = Date.now()
    // sliceMax() is binary -- 0 until the whole asset lands, then final --
    // so it can never show a slow download progressing. loadProgress() is
    // copper3d's real fractional byte progress; it can be NaN mid-flight,
    // so compare with Object.is (NaN !== NaN, but Object.is(NaN, NaN) is
    // true, and a number-to-NaN transition still reads as a change).
    let lastProgress = api.loadProgress()

    while (Date.now() - began < ceilingMs) {
      await new Promise(r => setTimeout(r, 100))
      if (token !== store.runToken) return false
      if (api.isFailed()) return false
      if (api.isReady()) return true
      const progress = api.loadProgress()
      if (!Object.is(progress, lastProgress)) { lastProgress = progress; lastChange = Date.now() }
      if (Date.now() - lastChange > stallMs) return false
    }
    return false
  }

  async function runDemo(demo: TourDemo, token: number) {
    const api = getTourStage(demo.panel)
    if (!api) return

    if (demo.kind === 'focusPanel') {
      deps.focusPanel(demo.panel)
      return
    }
    if (demo.kind === 'locateLesion') {
      api.locate()
      return
    }
    if (demo.kind === 'orbit') {
      // Only the orbit demo moves the camera, so only it needs to capture
      // and restore a pose. Captured here (not up front) and deleted right
      // after its own restore, so exitTour only ever restores a demo that
      // was interrupted before it could put the camera back itself --
      // never a reader's own rotation made after the demo finished.
      const pose = api.snapshot()
      if (pose) captured.set(demo.panel, pose)
      await api.orbit(demo.degrees * DEG, demo.durationMs)
      if (token !== store.runToken) return
      const entry = captured.get(demo.panel)
      if (entry) {
        api.applyPose(entry)
        captured.delete(demo.panel)
      }
      return
    }
    // scrubSlices: step to the far end of the volume and back to where the
    // reader actually was, so nothing is left displaced.
    const max = api.sliceMax()
    if (max <= 0) return

    // Where the reader ACTUALLY was, read from the stage -- not `max / 2`,
    // which only ever looked right because the app's own default happens to
    // open near the middle. Recorded before the first scrub so `restoreCaptured`
    // can put it back even if this demo never reaches its own restore.
    capturedSlices.set(demo.panel, api.sliceIndex())

    api.scrubTo(max)
    await new Promise(r => setTimeout(r, demo.durationMs))

    // Restore FIRST, then honour staleness. The old order returned on a
    // superseded token without restoring, which is precisely how the volume
    // got left on its last slice -- and auto-advance supersedes this step as
    // a matter of course, because the dwell timer runs while this demo waits.
    const from = capturedSlices.get(demo.panel)
    if (from !== undefined) {
      api.scrubTo(from)
      capturedSlices.delete(demo.panel)
    }
  }

  /** Runs one step end to end. Never throws; never blocks indefinitely. */
  async function runStep(step: TourStep) {
    try {
      await runStepBody(step)
    }
    catch {
      // A caller-supplied dep (navigate, focusPanel, a TourStageApi method,
      // ...) can throw synchronously or reject. The tour must never die
      // mid-step for it -- fall back to the manual copy like any other
      // degraded step.
      store.phase = 'fallback'
    }
  }

  async function runStepBody(step: TourStep) {
    const token = store.runToken

    if (step.route && deps.currentRoute() !== step.route) {
      await deps.navigate(step.route)
      if (token !== store.runToken) return
    }
    await runPrepare(step)
    if (token !== store.runToken) return

    if (!step.demo) {
      store.phase = 'playing'
      return
    }

    const api = getTourStage(step.demo.panel)
    // Reduced motion means no automatic movement at all -- the reader gets
    // the manual instructions instead, which is the honest version of the
    // same information.
    if (api?.prefersReducedMotion()) {
      store.phase = 'fallback'
      return
    }

    const ready = step.requiresStage
      ? await awaitStage(step.requiresStage, token)
      : true
    if (token !== store.runToken) return
    if (!ready) {
      store.phase = 'fallback'
      return
    }

    store.phase = 'playing'
    await runDemo(step.demo, token)
  }

  function startTour() {
    sidebarOpenAtStart = deps.isSidebarOpen()
    const scope = layoutScope()
    store.start(scope, tourSteps(scope).length, deps.currentRoute())
  }

  /** Restores every captured pose AND slice index and clears both maps, then
   *  puts the sidebar back exactly how the reader had it (see
   *  `sidebarOpenAtStart`). Shared by exitTour and finishTour -- exiting then
   *  also navigates, finishing does not, but both must leave the app as they
   *  found it. Finishing matters as much as exiting here: the reported
   *  "deformed panel" was seen by readers who let the tour run to its end. */
  function restoreCaptured() {
    for (const [panel, pose] of captured) getTourStage(panel)?.applyPose(pose)
    captured.clear()
    for (const [panel, index] of capturedSlices) getTourStage(panel)?.scrubTo(index)
    capturedSlices.clear()
    if (deps.isSidebarOpen() !== sidebarOpenAtStart) {
      if (sidebarOpenAtStart) deps.openSidebar()
      else deps.closeSidebar()
    }
  }

  /** Puts everything back: every captured pose, then the entry route. */
  async function exitTour() {
    restoreCaptured()
    const back = store.entryRoute
    store.exit()
    if (deps.currentRoute() !== back) await deps.navigate(back)
  }

  /** Restores every captured pose and ends the tour WITHOUT navigating --
   *  finishing leaves the reader on the last step's page; only exiting
   *  returns them to where they started. Without the clear in
   *  restoreCaptured, a pose captured on one run would still be sitting in
   *  `captured` for the next run's exitTour to wrongly restore. */
  function finishTour() {
    restoreCaptured()
    store.exit()
  }

  return {
    steps, currentStep, resolveTarget, isWideLayout, layoutScope, runStep, startTour, exitTour,
    finishTour,
  }
}
