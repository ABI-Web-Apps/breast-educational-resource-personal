import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTourStages, registerTourStage } from '../src/composables/useTourStageBridge'
import type { TourStageApi } from '../src/composables/useTourStageBridge'
import { useTourDirector } from '../src/composables/useTourDirector'
import { useTourStore } from '../src/stores/tour'
import type { TourStep } from '../src/content/tourTypes'

function stage(overrides: Partial<TourStageApi> = {}): TourStageApi {
  return {
    isReady: () => true,
    isFailed: () => false,
    snapshot: () => ({ position: [0, 0, 1], up: [0, 1, 0], target: [0, 0, 0] }),
    applyPose: vi.fn(),
    orbit: vi.fn(async () => {}),
    scrubTo: vi.fn(),
    // Deliberately NOT sliceMax/2: the scrub demo used to "restore" to the
    // midpoint regardless of where the reader actually was, and a fake that
    // happened to sit on the midpoint could never tell the two apart.
    sliceIndex: () => 7,
    sliceMax: () => 100,
    loadProgress: () => 1,
    lesionSliceIndex: () => 62,
    locate: vi.fn(),
    reset: vi.fn(),
    prefersReducedMotion: () => false,
    ...overrides,
  }
}

function makeDirector(extra: Partial<Parameters<typeof useTourDirector>[0]> = {}) {
  const navigate = vi.fn(async () => {})
  const focusPanel = vi.fn()
  const openSidebar = vi.fn()
  const closeSidebar = vi.fn()
  const isSidebarOpen = vi.fn(() => false)
  const expandSheet = vi.fn()
  const director = useTourDirector({
    navigate,
    focusPanel,
    openSidebar,
    closeSidebar,
    isSidebarOpen,
    expandSheet,
    currentRoute: () => '/the-breast/anatomy',
    stallMs: 20,
    ceilingMs: 100,
    ...extra,
  })
  return { director, navigate, focusPanel, openSidebar, closeSidebar, isSidebarOpen, expandSheet }
}

const ORBIT_STEP: TourStep = {
  id: 'rotate', chapter: 'interacting', target: ['[data-panel="anatomy"]'],
  title: 'T', body: 'demo copy', bodyFallback: 'manual copy',
  demo: { kind: 'orbit', panel: 'anatomy', degrees: 120, durationMs: 10 },
  requiresStage: 'anatomy',
}

describe('tour director', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearTourStages()
    document.body.innerHTML = '<div data-panel="anatomy"></div>'
  })

  it('resolves the first matching selector and skips a step whose targets all miss', async () => {
    const { director } = makeDirector()
    expect(director.resolveTarget({ ...ORBIT_STEP, target: ['#nope', '[data-panel="anatomy"]'] }))
      .toBe(document.querySelector('[data-panel="anatomy"]'))
    expect(director.resolveTarget({ ...ORBIT_STEP, target: ['#nope'] })).toBeNull()
  })

  /**
   * B1: a match with no layout box (e.g. `display:none`, as a one-up
   * layout's non-focused panel is) must not win -- it can never be
   * spotlighted, only drawn as a breathing dot at the viewport origin.
   * happy-dom has no layout engine, so `getClientRects()` always returns one
   * zero-size rect regardless of CSS; a real hidden element is simulated
   * directly here, the same way a real browser's `display:none` makes
   * `getClientRects().length` 0.
   */
  it('resolveTarget skips a match with no layout box and falls through to the next selector', async () => {
    const { director } = makeDirector()
    document.body.innerHTML += '<div data-tour="fallback"></div>'
    const hidden = document.querySelector<HTMLElement>('[data-panel="anatomy"]')!
    hidden.getClientRects = () => ({ length: 0 }) as unknown as DOMRectList
    expect(director.resolveTarget({
      ...ORBIT_STEP, target: ['[data-panel="anatomy"]', '[data-tour="fallback"]'],
    })).toBe(document.querySelector('[data-tour="fallback"]'))
  })

  it('resolveTarget returns null when every match has no layout box', async () => {
    const { director } = makeDirector()
    const hidden = document.querySelector<HTMLElement>('[data-panel="anatomy"]')!
    hidden.getClientRects = () => ({ length: 0 }) as unknown as DOMRectList
    expect(director.resolveTarget({ ...ORBIT_STEP, target: ['[data-panel="anatomy"]'] })).toBeNull()
  })

  it('runs the demo when the stage is already ready', async () => {
    const api = stage()
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(api.orbit).toHaveBeenCalledOnce()
    expect(useTourStore().phase).toBe('playing')
  })

  it('restores the entry pose after the demo', async () => {
    const api = stage()
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(api.applyPose).toHaveBeenCalledWith({ position: [0, 0, 1], up: [0, 1, 0], target: [0, 0, 0] })
  })

  it('waits, then falls back when the stage never becomes ready', async () => {
    registerTourStage('anatomy', stage({ isReady: () => false }))
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(useTourStore().phase).toBe('fallback')
  })

  it('skips the demo outright when the stage has failed to load', async () => {
    const api = stage({ isReady: () => false, isFailed: () => true })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(api.orbit).not.toHaveBeenCalled()
    expect(useTourStore().phase).toBe('fallback')
  })

  it('skips the demo when no stage ever registered for that panel', async () => {
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(useTourStore().phase).toBe('fallback')
  })

  it('does not orbit under reduced motion; it goes straight to the manual copy', async () => {
    const api = stage({ prefersReducedMotion: () => true })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(api.orbit).not.toHaveBeenCalled()
    expect(useTourStore().phase).toBe('fallback')
  })

  it('a step advanced while waiting voids its queued demo', async () => {
    let ready = false
    const api = stage({ isReady: () => ready })
    registerTourStage('anatomy', api)
    const { director } = makeDirector({ stallMs: 200 })
    const store = useTourStore()
    store.start('wide', 5, '/')
    const running = director.runStep(ORBIT_STEP)
    store.next()          // bumps runToken
    ready = true
    await running
    expect(api.orbit).not.toHaveBeenCalled()
  })

  it('gives up at the ceiling even when progress keeps ticking (never trips the stall window)', async () => {
    let progress = 0
    const api = stage({ isReady: () => false, loadProgress: () => (progress += 0.01) })
    registerTourStage('anatomy', api)
    // stallMs is large enough that steadily-increasing progress never trips
    // it; only the absolute ceiling can end this wait.
    const { director } = makeDirector({ stallMs: 1000, ceilingMs: 250 })
    await director.runStep(ORBIT_STEP)
    expect(useTourStore().phase).toBe('fallback')
  })

  it('steady progress keeps the tour waiting instead of tripping the stall window', async () => {
    let p = 0
    const api = stage({ isReady: () => false, loadProgress: () => (p += 0.05) })
    registerTourStage('anatomy', api)
    // stallMs is short and ceilingMs is long -- the opposite of the ceiling
    // test above. With a real progress signal this must still be 'waiting'
    // well past stallMs; a frozen signal (e.g. sliceMax(), constant in this
    // fake) would have declared it stalled by then.
    const { director } = makeDirector({ stallMs: 50, ceilingMs: 2000 })
    const store = useTourStore()
    const running = director.runStep(ORBIT_STEP)
    await new Promise(r => setTimeout(r, 250))
    expect(store.phase).toBe('waiting')
    store.next() // bump runToken so the pending wait exits promptly instead of running to the ceiling
    await running
  })

  it('a throwing dep degrades to fallback instead of rejecting', async () => {
    const { director } = makeDirector({
      navigate: vi.fn(() => { throw new Error('boom') }),
    })
    await expect(director.runStep({
      id: 'x', chapter: 'lesion', title: 'T', body: 'B', route: '/cancer-ductal/mri',
    })).resolves.toBeUndefined()
    expect(useTourStore().phase).toBe('fallback')
  })

  it('navigates first when the step names a route', async () => {
    const { director, navigate } = makeDirector()
    await director.runStep({ id: 'x', chapter: 'lesion', title: 'T', body: 'B', route: '/cancer-ductal/mri' })
    expect(navigate).toHaveBeenCalledWith('/cancer-ductal/mri')
  })

  it('runs prepare actions before showing the card', async () => {
    const { director, openSidebar, focusPanel } = makeDirector()
    await director.runStep({
      id: 'x', chapter: 'layout', title: 'T', body: 'B',
      prepare: [{ kind: 'openSidebar' }, { kind: 'focusPanel', panel: 'mri' }],
    })
    expect(openSidebar).toHaveBeenCalled()
    expect(focusPanel).toHaveBeenCalledWith('mri')
  })

  it('runs the closeSidebar prepare action (B2: case-heading closes what case-list opened)', async () => {
    const { director, closeSidebar } = makeDirector()
    await director.runStep({
      id: 'x', chapter: 'layout', title: 'T', body: 'B',
      prepare: [{ kind: 'closeSidebar' }],
    })
    expect(closeSidebar).toHaveBeenCalled()
  })

  it('B2: exitTour restores the sidebar to its pre-tour state when the tour left it open', async () => {
    let open = false // reader had it closed before starting the tour
    const { director } = makeDirector({
      isSidebarOpen: () => open,
      openSidebar: () => { open = true },
      closeSidebar: () => { open = false },
    })
    director.startTour()
    open = true // simulate the case-list step's openSidebar firing, never closed again
    await director.exitTour()
    expect(open).toBe(false)
  })

  it('B2: finishTour also restores the sidebar to its pre-tour state', async () => {
    let open = true // reader had it open before starting the tour
    const { director } = makeDirector({
      isSidebarOpen: () => open,
      openSidebar: () => { open = true },
      closeSidebar: () => { open = false },
    })
    director.startTour()
    open = false
    director.finishTour()
    expect(open).toBe(true)
  })

  it('B2: does not touch the sidebar on exit when the tour never changed its state', async () => {
    let open = false
    const openSidebar = vi.fn(() => { open = true })
    const closeSidebar = vi.fn(() => { open = false })
    const { director } = makeDirector({ isSidebarOpen: () => open, openSidebar, closeSidebar })
    director.startTour()
    await director.exitTour()
    expect(openSidebar).not.toHaveBeenCalled()
    expect(closeSidebar).not.toHaveBeenCalled()
  })

  it('scrubSlices walks to the last slice and locateLesion jumps to the lesion', async () => {
    const api = stage()
    registerTourStage('mri', api)
    const { director } = makeDirector()
    await director.runStep({
      id: 's', chapter: 'interacting', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'scrubSlices', panel: 'mri', durationMs: 10 }, requiresStage: 'mri',
    })
    expect(api.scrubTo).toHaveBeenCalled()

    await director.runStep({
      id: 'l', chapter: 'lesion', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'locateLesion', panel: 'mri' }, requiresStage: 'mri',
    })
    expect(api.locate).toHaveBeenCalledOnce()
  })

  it('startTour picks the wide script when a non-focused panel is visible', () => {
    document.body.innerHTML = `
      <div data-tour="panels">
        <div data-panel="anatomy" data-focused="true"></div>
        <div data-panel="mri" data-focused="false"></div>
      </div>`
    // happy-dom reports display:block for anything without a rule, which is
    // exactly the "not hidden" signal isWideLayout reads.
    const { director } = makeDirector()
    expect(director.isWideLayout()).toBe(true)
  })

  it('the focus demo asks the host to focus, and does not need a pose snapshot', async () => {
    const api = stage()
    registerTourStage('mammogram', api)
    const { director, focusPanel } = makeDirector()
    await director.runStep({
      id: 'focus', chapter: 'reading', title: 'T',
      body: 'B', bodyFallback: 'F',
      demo: { kind: 'focusPanel', panel: 'mammogram' }, requiresStage: 'mammogram',
    })
    expect(focusPanel).toHaveBeenCalledWith('mammogram')
    expect(api.orbit).not.toHaveBeenCalled()
  })

  it('the focus demo still degrades when the mammogram stage never arrives', async () => {
    registerTourStage('mammogram', stage({ isReady: () => false }))
    const { director, focusPanel } = makeDirector()
    await director.runStep({
      id: 'focus', chapter: 'reading', title: 'T',
      body: 'B', bodyFallback: 'F',
      demo: { kind: 'focusPanel', panel: 'mammogram' }, requiresStage: 'mammogram',
    })
    expect(focusPanel).not.toHaveBeenCalled()
    expect(useTourStore().phase).toBe('fallback')
  })

  it('exitTour restores the entry route and every captured pose', async () => {
    const api = stage()
    registerTourStage('anatomy', api)
    const { director, navigate } = makeDirector()
    const store = useTourStore()
    store.start('wide', 5, '/density-c/mri')
    await director.runStep(ORBIT_STEP)
    await director.exitTour()
    expect(store.active).toBe(false)
    expect(navigate).toHaveBeenLastCalledWith('/density-c/mri')
  })

  it('captures the pose before orbiting and restores exactly it afterwards', async () => {
    const pose = { position: [4, 5, 6], up: [0, 1, 0], target: [1, 1, 1] }
    const api = stage({ snapshot: () => pose })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    await director.runStep(ORBIT_STEP)
    expect(api.applyPose).toHaveBeenCalledWith(pose)
  })

  it('exiting mid-orbit still restores the captured pose', async () => {
    const pose = { position: [7, 8, 9], up: [0, 1, 0], target: [0, 0, 0] }
    const store = useTourStore()
    // Bump the run token while the orbit is in flight, so runDemo's own
    // post-orbit restore is skipped and the entry is left for exitTour.
    const api = stage({
      snapshot: () => pose,
      orbit: vi.fn(async () => { store.next() }),
    })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    store.start('wide', 14, '/the-breast/anatomy')
    await director.runStep(ORBIT_STEP)
    expect(api.applyPose).not.toHaveBeenCalled() // interrupted: no restore yet
    await director.exitTour()
    expect(api.applyPose).toHaveBeenCalledWith(pose)
  })

  it('a completed orbit is not re-applied on exit, so the reader keeps their own rotation', async () => {
    const pose = { position: [1, 2, 3], up: [0, 1, 0], target: [0, 0, 0] }
    const api = stage({ snapshot: () => pose })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()
    useTourStore().start('wide', 14, '/the-breast/anatomy')
    await director.runStep(ORBIT_STEP)
    expect(api.applyPose).toHaveBeenCalledWith(pose) // its own restore ran
    ;(api.applyPose as ReturnType<typeof vi.fn>).mockClear()
    await director.exitTour()
    expect(api.applyPose).not.toHaveBeenCalled() // and exit must not redo it
  })

  /**
   * This test used to assert the last scrub was `Math.round(max / 2)`, i.e.
   * it pinned the bug: the demo returned the reader to the MIDDLE of the
   * volume rather than to the slice they were actually on. It only ever
   * looked correct because the app's own default opens near the middle.
   */
  it('the slice demo returns the volume to the slice the reader was on, not the midpoint', async () => {
    const api = stage({ sliceMax: () => 104, sliceIndex: () => 13 })
    registerTourStage('mri', api)
    const { director } = makeDirector()
    await director.runStep({
      id: 'slices', chapter: 'interacting', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'scrubSlices', panel: 'mri', durationMs: 5 }, requiresStage: 'mri',
    })
    const calls = (api.scrubTo as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(calls[0]).toBe(104)
    expect(calls.at(-1)).toBe(13)
    expect(calls.at(-1)).not.toBe(52)
  })

  /**
   * The reported defect, in the shape it actually reached readers: the tour
   * auto-advances, so the dwell timer routinely fires while this demo is
   * still waiting out `durationMs`. The old code checked `runToken` and
   * returned BEFORE restoring, so a superseded step left the volume parked
   * on its last slice -- where the plane sits far closer to the camera and
   * renders oversized, spilling outside the panel. Measured on a real run:
   * the MRI read 191/191 after a full tour where a fresh load reads 96/191.
   */
  it('restores the slice even when the step is superseded mid-demo', async () => {
    const api = stage({ sliceMax: () => 104, sliceIndex: () => 13 })
    registerTourStage('mri', api)
    const { director } = makeDirector()
    const store = useTourStore()

    const running = director.runStep({
      id: 'slices', chapter: 'interacting', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'scrubSlices', panel: 'mri', durationMs: 60 }, requiresStage: 'mri',
    })

    // The supersede has to land INSIDE the demo's own wait -- after it has
    // scrubbed to the far end, before it restores. Bumping the token any
    // earlier is a different (already-covered) case: the step is voided
    // before the demo starts, so there is nothing to put back. Waiting for
    // the first scrub is what pins the window this bug actually lived in.
    const scrubbed = api.scrubTo as ReturnType<typeof vi.fn>
    for (let i = 0; i < 200 && scrubbed.mock.calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 1))
    }
    expect(scrubbed.mock.calls[0]?.[0], 'the demo never reached the far end').toBe(104)

    // Whatever supersedes the step -- Next, Back, auto-advance -- bumps the
    // run token. That must not cost the reader their slice.
    store.next()
    await running

    const calls = scrubbed.mock.calls.map(c => c[0])
    expect(calls.at(-1), 'the volume was left on the last slice').toBe(13)
  })

  /** And the belt to that braces: even if a demo never reaches its own
   *  restore at all, leaving the tour puts the slice back. */
  it('restoreCaptured puts an interrupted scrub back on exit', async () => {
    const api = stage({ sliceMax: () => 104, sliceIndex: () => 13 })
    registerTourStage('mri', api)
    const { director } = makeDirector()
    const store = useTourStore()
    store.start('wide', 3, '/the-breast/anatomy')

    const running = director.runStep({
      id: 'slices', chapter: 'interacting', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'scrubSlices', panel: 'mri', durationMs: 5 }, requiresStage: 'mri',
    })
    await running
    ;(api.scrubTo as ReturnType<typeof vi.fn>).mockClear()

    director.finishTour()
    // Already restored by the demo itself, so nothing is owed -- the map was
    // cleared. What this pins is that finishing does not RE-scrub to a stale
    // index, which is how a "restore everything" hook goes wrong.
    expect(api.scrubTo).not.toHaveBeenCalled()
  })

  it('a volume with no slices skips the scrub instead of dividing by zero', async () => {
    const api = stage({ sliceMax: () => 0 })
    registerTourStage('mri', api)
    const { director } = makeDirector()
    await director.runStep({
      id: 'slices', chapter: 'interacting', title: 'T', body: 'B', bodyFallback: 'F',
      demo: { kind: 'scrubSlices', panel: 'mri', durationMs: 5 }, requiresStage: 'mri',
    })
    expect(api.scrubTo).not.toHaveBeenCalled()
  })

  it('navigates to the lightest cancer case before the lesion steps', async () => {
    const { director, navigate } = makeDirector({ currentRoute: () => '/the-breast/anatomy' })
    await director.runStep({
      id: 'lesion-case', chapter: 'lesion', route: '/cancer-ductal/mri',
      target: ['[data-panel="mri"]'], title: 'T', body: 'B',
    })
    expect(navigate).toHaveBeenCalledWith('/cancer-ductal/mri')
  })

  it('does not re-navigate when already on the step\'s route', async () => {
    const { director, navigate } = makeDirector({ currentRoute: () => '/cancer-ductal/mri' })
    await director.runStep({
      id: 'lesion-case', chapter: 'lesion', route: '/cancer-ductal/mri',
      title: 'T', body: 'B',
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  // The brief this test came from claimed "'Finish' is exitTour in
  // TourLayer" -- that is exactly backwards (see finishTour() below):
  // exiting navigates back to the entry route, finishing does not. What
  // this test actually pins is narrower and still true: exitTour() itself
  // must behave the same regardless of stepIndex -- it is TourLayer's
  // advance() that branches on atEnd, not exitTour().
  it('exitTour returns to the entry route even when the reader is at the last step', async () => {
    const { director, navigate } = makeDirector({ currentRoute: () => '/cancer-ductal/mri' })
    const store = useTourStore()
    store.start('wide', 14, '/the-breast/anatomy')
    store.goToStep(13)
    expect(store.atEnd).toBe(true)
    await director.exitTour()
    expect(navigate).toHaveBeenCalledWith('/the-breast/anatomy')
  })

  it('finishTour ends the tour and restores captured poses without navigating', async () => {
    const pose = { position: [7, 8, 9], up: [0, 1, 0], target: [0, 0, 0] }
    const store = useTourStore()
    // Interrupted mid-orbit, so runDemo's own restore never runs and the
    // entry is left in `captured` for finishTour to pick up.
    const api = stage({
      snapshot: () => pose,
      orbit: vi.fn(async () => { store.next() }),
    })
    registerTourStage('anatomy', api)
    const { director, navigate } = makeDirector()
    store.start('wide', 14, '/the-breast/anatomy')
    await director.runStep(ORBIT_STEP)
    director.finishTour()
    expect(api.applyPose).toHaveBeenCalledWith(pose)
    expect(store.active).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  /**
   * Fix round 1: finishTour() used to restore captured poses without
   * clearing the map (TourLayer's old, local copy). A pose captured on one
   * run then survived into the NEXT run, so exiting the next run before any
   * demo captured anything of its own re-applied the stale pose from the
   * previous run -- exactly the case this pins.
   */
  it('finishTour clears what it restores, so the next run\'s exitTour cannot re-apply a stale pose', async () => {
    const pose = { position: [7, 8, 9], up: [0, 1, 0], target: [0, 0, 0] }
    const store = useTourStore()
    const api = stage({
      snapshot: () => pose,
      orbit: vi.fn(async () => { store.next() }),
    })
    registerTourStage('anatomy', api)
    const { director } = makeDirector()

    // First run: the orbit demo is interrupted, leaving `pose` captured;
    // finishTour restores and (should) clear it.
    store.start('wide', 14, '/the-breast/anatomy')
    await director.runStep(ORBIT_STEP)
    director.finishTour()
    ;(api.applyPose as ReturnType<typeof vi.fn>).mockClear()

    // Second run: exits immediately, before any demo of its own runs. If
    // the first run's pose were still sitting in `captured`, this would
    // wrongly re-apply it.
    store.start('wide', 14, '/the-breast/anatomy')
    await director.exitTour()
    expect(api.applyPose).not.toHaveBeenCalledWith(pose)
  })
})
