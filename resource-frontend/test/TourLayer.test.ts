import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TourLayer from '../src/components/tour/TourLayer.vue'
import { useTourStore } from '../src/stores/tour'
import type { TourStep } from '../src/content/tourTypes'

/**
 * The tests below stub `useTourDirector`, `useRoute` and `navigateTo` as
 * globals -- what TourLayer read when they were Nuxt auto-imports. TourLayer
 * imports them now, so these mocks route each import through the stub a
 * test installed, falling back to the real module when there is none.
 * (`navigateTo` already goes through test/setup.ts's router.)
 */
vi.mock('../src/composables/useTourDirector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/composables/useTourDirector')>()
  return {
    ...actual,
    useTourDirector: (...args: Parameters<typeof actual.useTourDirector>) => {
      const stub = (globalThis as { useTourDirector?: typeof actual.useTourDirector }).useTourDirector
      return typeof stub === 'function' ? stub(...args) : actual.useTourDirector(...args)
    },
  }
})
vi.mock('../src/navigation/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/navigation/router')>()
  const { computed } = await import('vue')
  return {
    ...actual,
    usePageRoute: () => {
      const stub = (globalThis as { useRoute?: () => unknown }).useRoute
      return typeof stub === 'function' ? computed(() => stub()) : actual.usePageRoute()
    },
  }
})

/**
 * Fix round 2, finding 2: the step watcher used to assign `targetEl`, paint
 * `data-tour-focus` and scroll AFTER `await director.runStep(s)` with no
 * staleness check. A second Next/Back arriving while the first step's
 * `runStep` was still pending (very reachable -- the rotate step's orbit
 * alone is 2500ms) let the OLDER step's tail overwrite the NEWER step's
 * paint once it finally resolved, and could leave `data-tour-focus` stuck
 * after the tour had already exited.
 *
 * `TourLayer`'s route, navigation and director are stubbed locally in this
 * file only, via `vi.stubGlobal` and the module mocks above. The fake director's `runStep` is a
 * controllable, per-step promise, so this test can hold the FIRST step
 * pending, let a SECOND step start and finish, and only then let the first
 * one resolve -- reproducing the exact interleaving the bug depended on.
 */
describe('TourLayer: superseded steps do not paint', () => {
  const pending = new Map<string, () => void>()

  beforeEach(() => {
    setActivePinia(createPinia())
    pending.clear()
    document.body.innerHTML = `
      <div data-tour-region data-region="a"><div data-target="a">A</div></div>
      <div data-tour-region data-region="b"><div data-target="b">B</div></div>
    `

    vi.stubGlobal('useRoute', () => ({ path: '/test' }))
    vi.stubGlobal('navigateTo', vi.fn(async () => {}))

    const steps: TourStep[] = [
      { id: 'a', chapter: 'layout', title: 'A', body: 'a' },
      { id: 'b', chapter: 'layout', title: 'B', body: 'b' },
    ]
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: (step: TourStep) => document.querySelector<HTMLElement>(`[data-target="${step.id}"]`),
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        // Never resolves on its own -- the test resolves it explicitly, so
        // the two steps' completion order is fully under the test's control.
        runStep: (step: TourStep) => new Promise<void>((resolve) => { pending.set(step.id, resolve) }),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
  })

  it("an older step's runStep resolving after a newer one does not repaint its own (stale) target", async () => {
    const store = useTourStore()
    mount(TourLayer)

    store.start('wide', 2, '/test') // step 'a' begins; its runStep is now pending
    await flushPromises()
    expect(pending.has('a')).toBe(true)

    store.next() // step 'b' begins (bumps runToken) while 'a' is still pending
    await flushPromises()
    expect(pending.has('b')).toBe(true)

    // 'b' settles first (the normal case); 'a' -- the interrupted step --
    // only catches up and resolves afterwards. This is the interleaving
    // that used to let the OLDER step's tail paint over the newer step's
    // already-correct paint once it finally settled.
    pending.get('b')!()
    await flushPromises()
    pending.get('a')!()
    await flushPromises()

    const regionA = document.querySelector('[data-region="a"]')!
    const regionB = document.querySelector('[data-region="b"]')!
    expect(regionB.hasAttribute('data-tour-focus')).toBe(true)
    expect(regionA.hasAttribute('data-tour-focus')).toBe(false)
  })

  it("an older step's runStep resolving after Escape does not leave data-tour-focus stuck", async () => {
    const store = useTourStore()
    mount(TourLayer)

    store.start('wide', 2, '/test')
    await flushPromises()
    expect(pending.has('a')).toBe(true)

    store.exit() // the reader leaves while 'a' is still pending
    await flushPromises()

    pending.get('a')!()
    await flushPromises()

    expect(document.body.hasAttribute('data-tour-active')).toBe(false)
    expect(document.querySelectorAll('[data-tour-focus]')).toHaveLength(0)
  })
})

/**
 * Task 11, carried-over finding from Task 10's review: a step that NAVIGATES
 * (`lesion-case`, route `/cancer-ductal/mri`) used to get the same "paint
 * before runStep" pass as any other step, which resolved its target against
 * whatever page the reader was still ON -- a stale, about-to-be-unmounted
 * element. Invisible in the real app only because every case shares the
 * same panel grid, so the stale rect coincides with the correct one; not a
 * guarantee, and not something a browser rect-position assertion could
 * distinguish (the two rects are the same by construction). So this pins
 * the decision at the level TourLayer actually makes it: DOM is unmounted
 * only by real navigation, which this fake `navigateTo`/`useRoute` stub
 * deliberately does not perform, leaving the pre-navigation element in
 * place -- the exact condition the fix must refuse to paint.
 */
describe('TourLayer: does not pre-paint a stale target across navigation', () => {
  const pending = new Map<string, () => void>()

  beforeEach(() => {
    setActivePinia(createPinia())
    pending.clear()
    document.body.innerHTML = `
      <div data-tour-region data-region="nav"><div data-target="nav">Nav</div></div>
    `

    vi.stubGlobal('useRoute', () => ({ path: '/test' }))
    vi.stubGlobal('navigateTo', vi.fn(async () => {}))

    const steps: TourStep[] = [
      { id: 'a', chapter: 'layout', title: 'A', body: 'a' },
      {
        id: 'nav', chapter: 'lesion', title: 'Nav', body: 'b',
        route: '/other', target: ['[data-target="nav"]'],
      },
    ]
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: (step: TourStep) => document.querySelector<HTMLElement>(`[data-target="${step.id}"]`),
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: (step: TourStep) => new Promise<void>((resolve) => { pending.set(step.id, resolve) }),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
  })

  it("does not paint a navigating step's pre-navigation target before runStep resolves", async () => {
    const store = useTourStore()
    mount(TourLayer)

    store.start('wide', 2, '/test') // step 'a', no target
    await flushPromises()
    pending.get('a')!()
    await flushPromises()

    store.next() // step 'nav': route '/other' differs from the stubbed '/test'
    await flushPromises()
    expect(pending.has('nav')).toBe(true)

    // The pre-paint pass has already run (it happens before `runStep` is
    // awaited); the fix must have refused to paint here, not found the
    // still-present, coincidentally-matching element.
    const region = document.querySelector('[data-region="nav"]')!
    expect(region.hasAttribute('data-tour-focus')).toBe(false)

    // Once runStep (standing in for the navigation) resolves, the
    // post-runStep pass is authoritative and paints normally.
    pending.get('nav')!()
    await flushPromises()
    expect(region.hasAttribute('data-tour-focus')).toBe(true)
  })
})

/**
 * I2: a step whose target is the PARENT of one or more `[data-tour-region]`
 * elements (e.g. `panels-wide` targeting `[data-tour="panels"]`, the wrapper
 * around all three panel regions) used to dim every region underneath it --
 * `paintRegions` only ever checked `el === target` or `el.contains(target)`,
 * never the reverse. Fixed by also treating a region as focused when the
 * target CONTAINS it.
 */
describe('TourLayer: a container target focuses the regions it contains', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = `
      <div data-target="wrapper">
        <div data-tour-region data-region="one"></div>
        <div data-tour-region data-region="two"></div>
      </div>
      <div data-tour-region data-region="unrelated"></div>
    `
    vi.stubGlobal('useRoute', () => ({ path: '/test' }))
    vi.stubGlobal('navigateTo', vi.fn(async () => {}))

    const steps: TourStep[] = [
      { id: 'wrap', chapter: 'reading', title: 'W', body: 'w', target: ['[data-target="wrapper"]'] },
    ]
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: (step: TourStep) => document.querySelector<HTMLElement>(step.target![0]!),
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: vi.fn(async () => {}),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
  })

  it('focuses (does not dim) every region the target wraps, and leaves siblings dimmed', async () => {
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 1, '/test')
    await flushPromises()

    expect(document.querySelector('[data-region="one"]')!.hasAttribute('data-tour-focus')).toBe(true)
    expect(document.querySelector('[data-region="two"]')!.hasAttribute('data-tour-focus')).toBe(true)
    expect(document.querySelector('[data-region="unrelated"]')!.hasAttribute('data-tour-focus')).toBe(false)
  })
})

/**
 * The whole-app blackout, and the guard against it.
 *
 * Two steps shipped targeting elements that sat outside every
 * `[data-tour-region]` -- the case heading and the one-up tab strip. No
 * region matched, so `paintRegions` dimmed all of them AND made all of them
 * `inert`: the reader got the entire app at 30% opacity, unusable, with the
 * card describing something they could no longer see. The two markup fixes
 * are in the components; this is the behaviour that stops the next one.
 *
 * `data-tour-nodim` sits on <body>, NOT on the regions, and that distinction
 * is the whole design: `data-tour-focus` has to keep meaning "this region is
 * the target", or the no-target window a navigating step passes through
 * would claim every region as the target of a step that has not arrived yet.
 */
describe('TourLayer: a step that matches no region dims nothing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // The target is real and resolvable -- it is simply not inside, around,
    // or equal to any region. Exactly the case-heading shape.
    document.body.innerHTML = `
      <div data-outside><div data-target="orphan">Heading</div></div>
      <div data-tour-region data-region="one"></div>
      <div data-tour-region data-region="two"></div>
    `
    vi.stubGlobal('useRoute', () => ({ path: '/test' }))
    vi.stubGlobal('navigateTo', vi.fn(async () => {}))

    const steps: TourStep[] = [
      { id: 'orphan', chapter: 'layout', title: 'O', body: 'o', target: ['[data-target="orphan"]'] },
    ]
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: (step: TourStep) => document.querySelector<HTMLElement>(step.target![0]!),
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: vi.fn(async () => {}),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
  })

  it('flags the body instead of dimming every region, and leaves nothing inert', async () => {
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 1, '/test')
    await flushPromises()

    expect(document.body.hasAttribute('data-tour-nodim')).toBe(true)
    for (const name of ['one', 'two']) {
      const region = document.querySelector<HTMLElement>(`[data-region="${name}"]`)!
      // Not claimed as the target -- it isn't one.
      expect(region.hasAttribute('data-tour-focus')).toBe(false)
      // But reachable: dimmed regions are inert, and an app where every
      // region is inert cannot be used or tabbed through at all.
      expect(region.inert).toBe(false)
    }
  })

  it('clears the flag when the tour ends', async () => {
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 1, '/test')
    await flushPromises()
    expect(document.body.hasAttribute('data-tour-nodim')).toBe(true)

    store.exit()
    await flushPromises()
    expect(document.body.hasAttribute('data-tour-nodim')).toBe(false)
  })
})

/**
 * T1: auto-advance with a pause control (design doc §1). Fake timers only
 * fake setTimeout/clearTimeout -- NOT setImmediate, which `flushPromises`
 * (via @vue/test-utils) relies on -- so the two coexist without either
 * hanging the other.
 */
describe('TourLayer: auto-advance', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = `<div data-stage-panel><div data-target="stage">Stage</div></div>`

    vi.stubGlobal('useRoute', () => ({ path: '/test' }))
    vi.stubGlobal('navigateTo', vi.fn(async () => {}))

    // 'short copy' is 2 words -> 2200 + 520 = 2720, below the 4000ms floor,
    // so every step here dwells for exactly the floor.
    const steps: TourStep[] = [
      { id: 'a', chapter: 'layout', title: 'A', body: 'short copy' },
      { id: 'b', chapter: 'layout', title: 'B', body: 'short copy' },
    ]
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: () => null,
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: vi.fn(async () => {}),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances on its own once the dwell time elapses after runStep resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()
    expect(store.stepIndex).toBe(0)

    await vi.advanceTimersByTimeAsync(3900)
    expect(store.stepIndex).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(store.stepIndex).toBe(1)
  })

  it('never fires before runStep resolves, even if the dwell time has technically elapsed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveStep!: () => void
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      const steps: TourStep[] = [
        { id: 'a', chapter: 'layout', title: 'A', body: 'short copy' },
        { id: 'b', chapter: 'layout', title: 'B', body: 'short copy' },
      ]
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: () => null,
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: () => new Promise<void>((resolve) => { resolveStep = resolve }),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()

    // The demo "runs" for 10s -- longer than the 4s dwell floor -- before
    // resolving. No timer can be armed yet, so stepIndex must not move.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.stepIndex).toBe(0)

    resolveStep()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3900)
    expect(store.stepIndex).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(store.stepIndex).toBe(1)
  })

  it('does not schedule an auto-advance from the last step (never auto-finishes)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()
    store.next() // reaches the last step; store.next() alone does not pause
    await flushPromises()
    expect(store.atEnd).toBe(true)
    expect(store.playing).toBe(true)

    await vi.advanceTimersByTimeAsync(12_000)
    expect(store.stepIndex).toBe(1)
    expect(store.active).toBe(true) // never auto-exits either
  })

  it('a paused reader (prefers-reduced-motion default, or an explicit pause) never auto-advances', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = useTourStore()
    store.pause()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(12_000)
    expect(store.stepIndex).toBe(0)
  })

  it('toggling playing back on mid-step arms the timer without waiting for a step change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = useTourStore()
    store.pause()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(12_000)
    expect(store.stepIndex).toBe(0) // still paused, no movement

    store.togglePlaying()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(4000)
    expect(store.stepIndex).toBe(1)
  })

  it('pointerdown on a stage panel pauses auto-advance (the rotate step invites dragging)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 2, '/test')
    await flushPromises()

    document.querySelector('[data-stage-panel]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(store.playing).toBe(false)

    await vi.advanceTimersByTimeAsync(12_000)
    expect(store.stepIndex).toBe(0)
  })

  it('a step change clears any pending timer so a superseded step cannot fire a stale advance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // 3 steps, not 2: with only 2, store.next() from the middle step is
    // already a no-op at the boundary, which would pass this test whether
    // or not the stale timer actually fired. The middle step here is NOT
    // atEnd, so a surviving stale timer is observable as a second advance.
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      const steps: TourStep[] = [
        { id: 'a', chapter: 'layout', title: 'A', body: 'short copy' },
        { id: 'b', chapter: 'layout', title: 'B', body: 'short copy' },
        { id: 'c', chapter: 'layout', title: 'C', body: 'short copy' },
      ]
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: () => null,
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: vi.fn(async () => {}),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 3, '/test')
    await flushPromises()

    await vi.advanceTimersByTimeAsync(3000) // most of the way through step 0's dwell (fires at 4000)
    store.next() // manual jump to step 1 (bypassing TourLayer's own pause-on-Next), armed for ~7000
    await flushPromises()
    expect(store.stepIndex).toBe(1)

    // If step 0's timer had survived, it would fire at 4000 and push
    // stepIndex to 2 well before step 1's own (~7000) timer is due.
    await vi.advanceTimersByTimeAsync(1200) // now at ~4200
    expect(store.stepIndex).toBe(1)
  })

  /**
   * Surgical version of the test above: `scheduleDwell()` itself also calls
   * `clearDwellTimer()`, so a step change that reaches a NEW `scheduleDwell()`
   * call clears the old timer as a side effect either way, which the test
   * above cannot tell apart from the watcher's own top-of-callback clear.
   * Holding the new step's `runStep` pending means `scheduleDwell()` is never
   * reached for it, isolating exactly the guarantee that the old timer is
   * gone the moment the step changes -- not merely by the time the new one
   * is armed. `vi.getTimerCount()` inspects the real pending-timer count
   * rather than inferring it from `store.next()`'s own no-op-past-the-end
   * safety net.
   */
  it('clears the outgoing timer immediately on step change, even before the new step arms its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveB!: () => void
    // 3 steps so 'b' (the middle one) is NOT atEnd -- otherwise scheduleDwell
    // would correctly refuse to arm it regardless of this test.
    vi.stubGlobal('useTourDirector', () => {
      const store = useTourStore()
      const steps: TourStep[] = [
        { id: 'a', chapter: 'layout', title: 'A', body: 'short copy' },
        { id: 'b', chapter: 'layout', title: 'B', body: 'short copy' },
        { id: 'c', chapter: 'layout', title: 'C', body: 'short copy' },
      ]
      return {
        steps: computed(() => steps),
        currentStep: computed(() => steps[store.stepIndex]),
        resolveTarget: () => null,
        isWideLayout: () => true,
        layoutScope: () => 'wide' as const,
        runStep: (step: TourStep) => step.id === 'a'
          ? Promise.resolve()
          : new Promise<void>((resolve) => { resolveB = resolve }),
        startTour: vi.fn(),
        exitTour: vi.fn(async () => { store.exit() }),
        finishTour: vi.fn(() => { store.exit() }),
      }
    })
    const store = useTourStore()
    mount(TourLayer)
    store.start('wide', 3, '/test')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1) // step a's own dwell timer armed

    store.next() // step b begins; its runStep is held pending indefinitely
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0) // a's timer is gone despite b's own not being armed yet

    resolveB()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1) // b's own timer now armed
  })
})
