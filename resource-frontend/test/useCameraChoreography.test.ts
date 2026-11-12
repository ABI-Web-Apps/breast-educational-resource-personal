import type { Ref } from 'vue'
import { defineComponent, ref, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopperCamera, CopperControls, CopperRenderer, CopperScene, StageApi, Vec3 } from '../src/composables/copper-types'
import type { Pose } from '../src/composables/cameraTransitions'
import { useCameraChoreography } from '../src/composables/useCameraChoreography'

/**
 * `useCameraChoreography` drives real camera math (cameraTransitions.test.ts
 * covers the pure interpolation itself) through copper3d's own
 * position/up/lookAt/updateProjectionMatrix setters, on a fake rAF clock
 * this file steps by hand -- no WebGL involved, matching the pattern
 * useCopperStage.test.ts and useModalityScene.test.ts already established
 * for this codebase. What's under test: the driver's requestContinuous /
 * releaseContinuous bracketing (a leak would starve the on-demand renderer
 * of frames, or worse, never let it go idle), interrupt-in-place semantics
 * (controller correction C3), reduced-motion skip/instant-jump (C6), and
 * the controls.target sync that C7 flags as load-bearing.
 */

/** A minimal but fully-functional Vec3 fake -- mutable in place via `.set`,
 * exactly the surface useCameraChoreography actually calls. The other
 * methods on the real `Vec3` interface are never exercised by this
 * composable (controller correction C1: mutation goes through `.set` only),
 * so they're stubbed just deeply enough to satisfy the type. */
function makeVec3(x = 0, y = 0, z = 0): Vec3 {
  const self: Vec3 = {
    x,
    y,
    z,
    set: (nx, ny, nz) => { self.x = nx; self.y = ny; self.z = nz },
    copy: (o) => { self.x = o.x; self.y = o.y; self.z = o.z; return self },
    clone: () => makeVec3(self.x, self.y, self.z),
    length: () => Math.hypot(self.x, self.y, self.z),
    normalize: () => self,
    lerp: () => self,
    applyAxisAngle: () => self,
    sub: () => self,
    add: () => self,
    multiplyScalar: () => self,
  }
  return self
}

function makeFakeScene(cameraPos: [number, number, number], up: [number, number, number] = [0, 1, 0]): CopperScene {
  const camera: CopperCamera = {
    position: makeVec3(...cameraPos),
    up: makeVec3(...up),
    lookAt: vi.fn(),
    updateProjectionMatrix: vi.fn(),
  }
  const controls: CopperControls = {
    rotateSpeed: 0,
    panSpeed: 0,
    enableRotate: true,
    enablePan: true,
    enabled: true,
    target: makeVec3(0, 0, 0),
  }
  return { camera, controls } as CopperScene
}

function makeFakeStage(): StageApi {
  const renderer = { render: vi.fn() } as unknown as CopperRenderer
  return {
    renderer: shallowRef(renderer),
    Copper: shallowRef(undefined),
    ready: shallowRef(true),
    loadError: shallowRef(undefined),
    requestContinuous: vi.fn(),
    releaseContinuous: vi.fn(),
  }
}

/** A hand-driven rAF clock: `requestAnimationFrame` just remembers the
 * latest callback instead of scheduling it, and `advance(ms)` invokes it
 * synchronously with a controlled, monotonically increasing timestamp.
 * `performance.now()` is stubbed to read the same clock (see `beforeEach`),
 * so `animate()`'s own `(now - start) / durationMs` math sees a consistent
 * timeline across multiple flights in one test. */
function makeFakeClock() {
  let now = 0
  let queued: FrameRequestCallback | null = null
  const raf = vi.fn((cb: FrameRequestCallback) => { queued = cb; return 1 })
  const caf = vi.fn(() => { queued = null })
  function advance(ms: number) {
    now += ms
    const cb = queued
    queued = null
    cb?.(now)
  }
  return { raf, caf, advance, now: () => now }
}

/** Mounts `useCameraChoreography` inside a real component instance so
 * `onMounted`/`onScopeDispose` genuinely run, matching useCopperStage.
 * test.ts's approach to the same lifecycle-hook concern. `stage`/`scene`
 * are captured via closure, not passed as props -- a `Ref` handed through
 * Vue's props system risks its own top-level auto-unwrapping. */
function mountChoreography(stage: StageApi, scene: Ref<CopperScene | undefined>) {
  let api!: ReturnType<typeof useCameraChoreography>
  const Host = defineComponent({
    setup() {
      api = useCameraChoreography(stage, scene)
      return {}
    },
    template: '<div />',
  })
  const wrapper = mount(Host)
  return { wrapper, camera: api }
}

describe('useCameraChoreography', () => {
  let clock: ReturnType<typeof makeFakeClock>

  beforeEach(() => {
    clock = makeFakeClock()
    // Re-stubbed every test, because `afterEach` deliberately does NOT call
    // `unstubAllGlobals` (it would wipe setup.ts's lifecycle stubs) and the
    // reduced-motion test below installs a `matches: true` version that
    // would otherwise leak forward and silently collapse every later
    // animation to a single instant frame.
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    vi.stubGlobal('requestAnimationFrame', clock.raf)
    vi.stubGlobal('cancelAnimationFrame', clock.caf)
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Not vi.unstubAllGlobals(): that would also wipe test/setup.ts's
    // ref/onMounted/onScopeDispose stubs (installed once, before this whole
    // file runs), which every subsequent test's component mount depends on.
    // beforeEach re-stubs requestAnimationFrame/cancelAnimationFrame fresh
    // for each test regardless.
  })

  /**
   * What is left of this composable is the app's single animation DRIVER.
   *
   * The camera choreography it was named for -- `flyTo`, `orbitIntro`,
   * `locateLesion`, and the `captureOrientation`/`applyOrientation` pair
   * that stitched a flight across two scenes -- was deleted at the human's
   * instruction; nothing moves the camera on its own initiative any more.
   * The tests for those went with them.
   *
   * These do not: the driver still runs the §7.1 density crossfade and the
   * slice follower, and every invariant below is one of those two would
   * silently lose. They drive `animate` directly rather than through a
   * camera move, which is what they were really testing all along.
   */
  const frames: number[] = []
  const record = (t: number) => { frames.push(t) }

  beforeEach(() => { frames.length = 0 })

  it('runs to exactly t=1 and resolves', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const { camera } = mountChoreography(makeFakeStage(), scene)

    const run = camera.animate(1000, record)
    clock.advance(500)
    clock.advance(500)
    await run

    expect(frames.length).toBeGreaterThan(1)
    expect(frames[frames.length - 1]).toBe(1)
  })

  it('leases and releases continuous rendering exactly once for a completed animation', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { camera } = mountChoreography(stage, scene)

    const run = camera.animate(1000, record)
    clock.advance(500)
    clock.advance(500)
    await run

    expect(stage.requestContinuous).toHaveBeenCalledTimes(1)
    expect(stage.releaseContinuous).toHaveBeenCalledTimes(1)
  })

  // Controller correction C3: interrupting must stop where the last
  // completed frame left it, never snap to either endpoint (the original
  // brief's `onFrame(1)` defect).
  it('interrupt() stops mid-animation without a final t=1 frame', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { camera } = mountChoreography(stage, scene)

    const run = camera.animate(1000, record)
    clock.advance(300)
    const atInterrupt = frames[frames.length - 1]!
    expect(atInterrupt).toBeGreaterThan(0)
    expect(atInterrupt).toBeLessThan(1)

    camera.interrupt()
    await run

    expect(frames[frames.length - 1]).toBe(atInterrupt)
    expect(stage.releaseContinuous).toHaveBeenCalledTimes(1)
  })

  it('starting a second animation takes ownership of the first', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { camera } = mountChoreography(stage, scene)

    const first = camera.animate(1000, record)
    clock.advance(300)
    const beforeSecond = frames.length

    const second: number[] = []
    const secondRun = camera.animate(1000, t => second.push(t))
    clock.advance(1000)
    await Promise.all([first, secondRun])

    // The first driver stopped feeding frames the moment the second started.
    expect(frames.length).toBe(beforeSecond)
    expect(second[second.length - 1]).toBe(1)
    // One lease per animation, both released.
    expect(stage.requestContinuous).toHaveBeenCalledTimes(2)
    expect(stage.releaseContinuous).toHaveBeenCalledTimes(2)
  })

  it('unmounting mid-animation stops it and releases the lease immediately', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { wrapper, camera } = mountChoreography(stage, scene)

    const run = camera.animate(1000, record)
    clock.advance(300)
    const atUnmount = frames.length

    wrapper.unmount()
    await run

    expect(stage.releaseContinuous).toHaveBeenCalledTimes(1)
    clock.advance(1000)
    expect(frames.length).toBe(atUnmount)
  })

  // Task 9's M-9: a throwing frame callback must not strand the lease. It is
  // the whole reason the release lives in a `finally`.
  it('a frame callback that throws rejects the animation and still releases the lease', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { camera } = mountChoreography(stage, scene)

    const run = camera.animate(1000, () => { throw new Error('frame blew up') })
    clock.advance(100)

    await expect(run).rejects.toThrow('frame blew up')
    expect(stage.releaseContinuous).toHaveBeenCalledTimes(1)
  })

  it('reduced motion collapses an animation to one instant t=1 frame, with no lease', async () => {
    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    const { camera } = mountChoreography(stage, scene)

    await camera.animate(1000, record)

    expect(frames).toEqual([1])
    expect(stage.requestContinuous).not.toHaveBeenCalled()
    expect(stage.releaseContinuous).not.toHaveBeenCalled()
  })

  describe('keyboard camera steps (design doc §11)', () => {
    it('nudgeOrbit rotates around the pivot without changing the orbit radius, and renders once', () => {
      const scene = shallowRef(makeFakeScene([0, 0, 10]))
      const stage = makeFakeStage()
      const { camera } = mountChoreography(stage, scene)
      scene.value!.controls.target!.set(0, 0, 0)

      camera.nudgeOrbit(Math.PI / 2, 0)

      const cam = scene.value!.camera
      expect(Math.hypot(cam.position.x, cam.position.y, cam.position.z)).toBeCloseTo(10, 6)
      expect(cam.position.z).toBeCloseTo(0, 6)
      expect(stage.renderer.value?.render).toHaveBeenCalledTimes(1)
      // Instant, so no continuous-render lease is taken at all.
      expect(stage.requestContinuous).not.toHaveBeenCalled()
    })

    it('zoomBy scales the distance from the pivot and keeps controls.target in sync', () => {
      const scene = shallowRef(makeFakeScene([0, 0, 10]))
      const stage = makeFakeStage()
      const { camera } = mountChoreography(stage, scene)
      scene.value!.controls.target!.set(0, 0, 2)

      camera.zoomBy(0.5)

      const cam = scene.value!.camera
      expect(cam.position.z).toBeCloseTo(6, 6) // pivot 2 + (10-2)*0.5
      expect(scene.value!.controls.target!.z).toBeCloseTo(2, 6)
    })

    // §7.4: any user input hands control back. A key press that left a
    // running orbit going would fight the user for the camera.
    it('a keyboard step takes ownership of a running animation instead of racing it', () => {
      const scene = shallowRef(makeFakeScene([0, 0, 10]))
      const stage = makeFakeStage()
      const { camera } = mountChoreography(stage, scene)

      // Any running animation will do -- this used to be `orbitIntro`,
      // which no longer exists. What is under test is that a key press takes
      // the driver's single cancel slot, not what the animation was.
      void camera.animate(1000, () => {})
      clock.advance(300)
      camera.nudgeOrbit(0.2, 0)
      const cam = scene.value!.camera
      const afterStepX = cam.position.x

      clock.advance(700) // the orbit's own remaining frames, if any survived
      expect(cam.position.x).toBeCloseTo(afterStepX, 10)
      expect(stage.releaseContinuous).toHaveBeenCalledTimes(1) // no leaked lease
    })
  })

  it('reads the media query on mount and updates prefersReducedMotion when it changes', () => {
    let changeHandler: (() => void) | undefined
    const mql = {
      matches: false,
      addEventListener: vi.fn((_type: string, h: () => void) => { changeHandler = h }),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mql))

    const scene = shallowRef(makeFakeScene([0, 0, 10]))
    const stage = makeFakeStage()
    const { camera } = mountChoreography(stage, scene)

    expect(camera.prefersReducedMotion.value).toBe(false)
    // Mirrors real MediaQueryList semantics: `matches` is already updated by
    // the time `change` fires, and the handler (`syncMotion`) reads it back
    // off the list rather than off the event object.
    mql.matches = true
    changeHandler?.()
    expect(camera.prefersReducedMotion.value).toBe(true)
  })

  describe('orbitBy / applyPose (tour-only, design doc D7)', () => {
    it('sweeps over many frames instead of cancelling itself on the first one', async () => {
      // nudgeOrbit() calls interrupt(), so it CANNOT drive animate()'s frame
      // callback -- it would kill the very animation feeding it. orbitBy
      // exists precisely because of that.
      //
      // Uses the outer `clock` (already wired to requestAnimationFrame/
      // cancelAnimationFrame by the top-level beforeEach) rather than a local
      // one -- a fresh makeFakeClock() here would shadow the name without
      // ever being the clock the global rAF stub actually calls.
      const scene = ref<CopperScene | undefined>(makeFakeScene([0, 0, 10]))
      const { camera, wrapper } = mountChoreography(makeFakeStage(), scene)

      const done = camera.orbitBy(Math.PI / 2, 400)
      clock.advance(120)
      const mid = scene.value!.camera.position.x
      clock.advance(400)
      await done

      expect(mid).not.toBe(0)
      expect(scene.value!.camera.position.x).not.toBe(mid)
      wrapper.unmount()
    })

    it('resolves immediately when there is no scene to orbit', async () => {
      const scene = ref<CopperScene | undefined>(undefined)
      const { camera, wrapper } = mountChoreography(makeFakeStage(), scene)
      await expect(camera.orbitBy(Math.PI, 200)).resolves.toBeUndefined()
      wrapper.unmount()
    })

    it('applyPose writes the pose through and renders', () => {
      const stage = makeFakeStage()
      const scene = ref<CopperScene | undefined>(makeFakeScene([0, 0, 10]))
      const { camera, wrapper } = mountChoreography(stage, scene)

      camera.applyPose({ position: [1, 2, 3], up: [0, 1, 0], target: [0, 0, 0] })
      expect(scene.value!.camera.position.x).toBe(1)
      expect(stage.renderer.value!.render).toHaveBeenCalled()
      wrapper.unmount()
    })

    it('applyPose takes ownership of an in-flight orbit, so a restore always wins', async () => {
      const scene = ref<CopperScene | undefined>(makeFakeScene([0, 0, 10]))
      const { camera, wrapper } = mountChoreography(makeFakeStage(), scene)

      const inFlight = camera.orbitBy(Math.PI, 5000)
      camera.applyPose({ position: [9, 9, 9], up: [0, 1, 0], target: [0, 0, 0] })
      clock.advance(6000)
      await inFlight

      expect(scene.value!.camera.position.x).toBe(9)
      wrapper.unmount()
    })
  })
})
