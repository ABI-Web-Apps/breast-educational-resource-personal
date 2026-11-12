import type { Ref } from 'vue'
import { defineComponent, ref, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { CopperControls, CopperScene } from '../src/composables/copper-types'
import type { SliceState } from '../src/composables/useModalityScene'
import { useSliceControl } from '../src/composables/useSliceControl'

/**
 * What is genuinely testable here without a browser: the slice arithmetic
 * (drag pixels -> slice numbers -> copper3d's world coordinate), the gate
 * that decides whether a drag scrubs or orbits, the OrbitControls hand-off
 * around a scrub, and which of the two readouts a screen reader is allowed
 * to hear (controller correction C11).
 *
 * What is NOT testable here, and is listed for the human browser pass: that
 * copper3d's raycast actually hits the slice plane where the pointer looks
 * like it is, and that the capture-phase `enableRotate = false` really does
 * beat OrbitControls' own bubble-phase pointerdown handler on the shared
 * canvas. Both depend on a real WebGL scene and a real event dispatch order
 * through copper3d's own listeners; neither is faked into a passing
 * assertion below.
 */

const SPACING = 2

function makeSliceState(overrides: Partial<{ index: number, max: number }> = {}): SliceState {
  const index = overrides.index ?? 0
  return {
    max: overrides.max ?? 100,
    raw: {
      index: index * SPACING,
      MaxIndex: overrides.max ?? 100,
      volume: { spacing: [1, 1, SPACING] },
      repaint: vi.fn(),
    },
    mesh: { name: 'z' },
  }
}

/** `pickSpecifiedModel` is made to hit or miss on demand -- the one thing
 * standing between "this drag scrubs" and "this drag orbits". */
function makeScene(hit: boolean, canRotate = true): CopperScene {
  const controls = {
    rotateSpeed: 0,
    panSpeed: 0,
    // TrackballControls' locks, not OrbitControls'. Writing `enableRotate`
    // on a trackball is a no-op, and a test double that accepted the wrong
    // name is how the real thing shipped broken: one drag both scrubbed the
    // slice and orbited the camera.
    noRotate: !canRotate,
    noPan: false,
    staticMoving: true,
    enabled: true,
    handleResize: vi.fn(),
  } as unknown as CopperControls
  return {
    controls,
    requestRenderIfNotRequested: vi.fn(),
    pickSpecifiedModel: vi.fn(() => ({ intersectedObject: hit ? { name: 'z' } : null })),
  } as unknown as CopperScene
}

/**
 * A hand-driven `requestAnimationFrame`.
 *
 * A drag no longer repaints per pointermove -- it coalesces to one repaint
 * per frame, because `repaint()` re-extracts the whole plane out of the
 * volume in JS and doing that 100+ times a second is what made scrubbing
 * stutter. So a test that dispatches moves and asserts immediately is
 * asserting before any work has happened. `flushFrame()` is where the work
 * happens, and having it explicit means the coalescing itself is testable.
 */
function makeFrameQueue() {
  const queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb)
    return queue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { delete queue[id - 1] })
  return {
    get pending() { return queue.filter(Boolean).length },
    flushFrame() {
      const due = queue.splice(0, queue.length)
      for (const cb of due) cb?.(0)
    },
  }
}

/** The injected animation driver. `instant` resolves the whole animation in
 * one frame (which is also exactly what the real driver does under reduced
 * motion); `stepped` hands the frames back so a test can drive them. */
function instantRun() {
  return vi.fn((_ms: number, onFrame: (t: number) => void) => {
    onFrame(1)
    return Promise.resolve()
  })
}

function steppedRun() {
  const frames: Array<{ onFrame: (t: number) => void, resolve: () => void }> = []
  const run = vi.fn((_ms: number, onFrame: (t: number) => void) => {
    return new Promise<void>((resolve) => {
      frames.push({ onFrame, resolve })
    })
  })
  return { run, frames }
}

function mountControl(
  scene: Ref<CopperScene | undefined>,
  sliceState: Ref<SliceState | null>,
  run: (ms: number, onFrame: (t: number) => void) => Promise<void>,
) {
  let api!: ReturnType<typeof useSliceControl>
  const host = ref<HTMLElement>()
  const Host = defineComponent({
    setup() {
      api = useSliceControl(host, scene, sliceState, run)
      return { host }
    },
    template: '<div ref="host" />',
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, api, el: host.value! }
}

/** happy-dom has no PointerEvent constructor; the handlers only ever read
 * `button`, `isPrimary`, `clientX` and `clientY`. */
function pointer(type: string, init: { clientY?: number, clientX?: number, button?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>
  event.button = init.button ?? 0
  event.isPrimary = true
  event.clientX = init.clientX ?? 0
  event.clientY = init.clientY ?? 0
  return event as unknown as PointerEvent
}

describe('useSliceControl', () => {
  it('starts from the loaded slice state rather than from zero', () => {
    const state = makeSliceState({ index: 42, max: 104 })
    const { api } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    expect(api.index.value).toBe(42)
    expect(api.max.value).toBe(104)
    expect(api.settledIndex.value).toBe(42)
  })

  /**
   * Fix round 1, Important. The readout and the follower must both start
   * from where the slice plane ACTUALLY is, which lives in
   * `raw.index` (a world coordinate) and nowhere else.
   *
   * Concrete failure this closes: open `/case/cancer-dcis/mri`, scrub to
   * 40, step to 3D Mammogram, step back. `load()`'s cache-hit branch
   * restores the same `SliceState` object it stored at load time, and the
   * scene was never repainted, so the plane is still at 40 -- but a
   * load-time snapshot would say 88, and the first drag pixel would ease
   * the plane 48 slices to catch up with a number that was only ever a
   * stale copy.
   */
  it('seeds from where the slice plane actually is, not from a value captured at load time', () => {
    // A cached scene coming back into view: the user scrubbed it to 40 on
    // an earlier visit and nothing has repainted it since.
    const state = makeSliceState({ index: 40, max: 175 })

    const { api } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    expect(api.index.value).toBe(40)
    expect(api.settledIndex.value).toBe(40)
  })

  it('starts a drag from the plane\'s real position, so the first pixel does not jump', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 40, max: 175 })
    const { el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 4 })) // +1 slice
    frames.flushFrame()

    expect(state.raw.index).toBeCloseTo(41 * SPACING, 10)
  })

  it('converts a vertical drag into slice numbers and writes copper3d\'s world coordinate', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 10 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 100 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 140 })) // +40px
    frames.flushFrame()

    // SENSITIVITY is 0.25 slices per pixel: 10 + 40*0.25 = 20 slices, and
    // `raw.index` is a WORLD coordinate, so 20 * spacing[2].
    expect(api.index.value).toBe(20)
    expect(state.raw.index).toBeCloseTo(20 * SPACING, 10)
    expect(state.raw.repaint).toHaveBeenCalled()
  })

  /**
   * A repaint is not a frame. This redraws the slice's backing canvas, and
   * under on-demand rendering nothing uploads that texture unless a frame is
   * asked for -- the stage keeps showing the previous slice.
   *
   * The drag used to ride useCopperStage's input pump for this. That pump is
   * gone (copper3d 3.9.0 fixed the camera deadlock it existed for at the
   * source), and a scrub suppresses rotation for its whole gesture anyway,
   * so the controls dispatch no `change` either. Nothing was left to
   * schedule the frame and the image stopped updating mid-drag.
   */
  it('asks for a frame after repainting, since a repaint is not a frame', () => {
    const frames = makeFrameQueue()
    const scene = makeScene(true)
    const { el } = mountControl(shallowRef(scene), shallowRef(makeSliceState({ index: 10 })), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 100 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 140 }))
    frames.flushFrame()

    expect(scene.requestRenderIfNotRequested).toHaveBeenCalled()
  })

  it('does not ask for a frame when the slice number did not change', () => {
    const frames = makeFrameQueue()
    const scene = makeScene(true)
    const { el } = mountControl(shallowRef(scene), shallowRef(makeSliceState({ index: 10 })), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 100 }))
    // 1px at 0.25 slices/px rounds back to the slice already on screen.
    el.dispatchEvent(pointer('pointermove', { clientY: 101 }))
    frames.flushFrame()

    expect(scene.requestRenderIfNotRequested).not.toHaveBeenCalled()
  })

  /**
   * The drag distance still accumulates across moves -- four 1px moves at
   * 0.25 slices each are one whole slice, not nothing -- but the PAINTED
   * index is always a whole slice, and only one repaint happens per frame
   * however many moves arrived in it.
   *
   * Both halves are load-bearing and they used to be the other way round.
   * The accumulator has to keep sub-slice precision or a slow drag rounds
   * away to nothing. The paint has to round, because only whole slices
   * exist: copper3d floors the value on the way in, so a fractional index
   * costs a full `repaint()` -- a JS pass over the entire plane -- to
   * display the picture that was already on screen.
   */
  it('accumulates sub-slice drag distance but paints whole slices, once per frame', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 0 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    for (let i = 1; i <= 4; i++) el.dispatchEvent(pointer('pointermove', { clientY: i }))

    // Four moves, and not one repaint yet: they coalesced into one frame.
    expect(state.raw.repaint).not.toHaveBeenCalled()
    expect(frames.pending).toBe(1)

    frames.flushFrame()
    expect(state.raw.repaint).toHaveBeenCalledTimes(1)
    expect(state.raw.index).toBeCloseTo(1 * SPACING, 10)
    expect(api.index.value).toBe(1)
  })

  it('does not repaint at all when a drag has not crossed into the next slice', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 10 })
    const { el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 1 })) // 0.25 of a slice
    frames.flushFrame()

    expect(state.raw.repaint).not.toHaveBeenCalled()
  })

  it('clamps at both ends of the volume', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 5, max: 20 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 4000 }))
    frames.flushFrame()
    expect(api.index.value).toBe(20)
    expect(state.raw.index).toBeCloseTo(20 * SPACING, 10)

    el.dispatchEvent(pointer('pointermove', { clientY: -4000 }))
    frames.flushFrame()
    expect(api.index.value).toBe(0)
    expect(state.raw.index).toBeCloseTo(0, 10)
  })

  // The legacy app gated on the same raycast (frontend/plugins/copper.js:90).
  // Without a gate, one drag both scrubs and orbits, because OrbitControls
  // listens on the same canvas.
  it('ignores a drag that does not start on the slice plane, and leaves rotation alone', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 10 })
    const scene = makeScene(false)
    const { api, el } = mountControl(shallowRef(scene), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 100 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 300 }))
    frames.flushFrame()

    expect(api.index.value).toBe(10)
    expect(scene.controls.noRotate).toBe(false)
  })

  it('suppresses camera rotation for the duration of a scrub and restores it afterwards', () => {
    const state = makeSliceState()
    const scene = makeScene(true)
    const { el } = mountControl(shallowRef(scene), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    expect(scene.controls.noRotate).toBe(true)

    el.dispatchEvent(pointer('pointerup', { clientY: 0 }))
    expect(scene.controls.noRotate).toBe(false)
  })

  // The 2D ultrasound modality ships with rotation already off
  // (useModalityScene's `flat` branch). Restoring a hardcoded `true` would
  // silently make the one flat modality orbitable after any scrub.
  it('restores rotation to whatever it was, not to true, so the 2D modality stays locked', () => {
    const state = makeSliceState()
    const scene = makeScene(true, false)
    const { el } = mountControl(shallowRef(scene), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointerup', { clientY: 0 }))

    expect(scene.controls.noRotate).toBe(true)
  })

  it('restores rotation on pointercancel too, so a cancelled gesture cannot leave the camera locked', () => {
    const state = makeSliceState()
    const scene = makeScene(true)
    const { el } = mountControl(shallowRef(scene), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointercancel', { clientY: 0 }))

    expect(scene.controls.noRotate).toBe(false)
  })

  it('steps one slice per [ and ] (design doc §11)', () => {
    const state = makeSliceState({ index: 10 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }))
    expect(api.index.value).toBe(11)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }))
    expect(api.index.value).toBe(9)
  })

  it('leaves other keys alone', () => {
    const state = makeSliceState({ index: 10 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    el.dispatchEvent(event)

    expect(api.index.value).toBe(10)
    expect(event.defaultPrevented).toBe(false)
  })

  /**
   * Controller correction C11. The visible number moves every frame of a
   * drag; the announced one must not, or a screen reader queues an utterance
   * per frame and the app becomes unusable with one on.
   *
   * This used to be checked through the injected animation driver, because a
   * drag used to go through it. It no longer does -- the plane tracks the
   * pointer directly -- so the invariant is checked against the thing that
   * actually drives it now: coalesced frames during the drag, one
   * announcement at pointer-up.
   */
  it('does not publish the announced index until the scrub actually comes to rest', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 0 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 20 }))
    frames.flushFrame()

    // The eye sees the number move; the screen reader does not.
    expect(api.index.value).toBe(5)
    expect(api.settledIndex.value).toBe(0)

    el.dispatchEvent(pointer('pointermove', { clientY: 40 }))
    frames.flushFrame()
    expect(api.index.value).toBe(10)
    expect(api.settledIndex.value).toBe(0)

    el.dispatchEvent(pointer('pointerup', { clientY: 40 }))
    expect(api.settledIndex.value).toBe(10)
  })

  it('announces once for a whole drag, not once per update', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 0 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    // Four separate painted frames, each moving the visible number.
    const seen: number[] = []
    for (const y of [10, 20, 30, 40]) {
      el.dispatchEvent(pointer('pointermove', { clientY: y }))
      frames.flushFrame()
      seen.push(api.index.value)
      // Sampled rather than watched: the announcement must not have moved
      // even once during the gesture.
      expect(api.settledIndex.value).toBe(0)
    }
    expect(seen).toEqual([2.5, 5, 7.5, 10].map(Math.round))

    el.dispatchEvent(pointer('pointerup', { clientY: 40 }))
    expect(api.settledIndex.value).toBe(10)
  })

  it('announces the frame the pointer-up beat, so the number read out is the one on screen', () => {
    const frames = makeFrameQueue()
    const state = makeSliceState({ index: 0 })
    const { api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 40 }))
    // No flush: the gesture ends before the coalesced frame ran.
    el.dispatchEvent(pointer('pointerup', { clientY: 40 }))

    expect(api.index.value).toBe(10)
    expect(api.settledIndex.value).toBe(10)
    expect(frames.pending).toBe(0)
  })


  it('syncFromRaw follows a slice another animation is driving, without announcing it', () => {
    const state = makeSliceState({ index: 0 })
    const { api } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    // What `locateLesion` does per frame: it writes the world coordinate
    // itself, and this composable only has to keep the readout in step.
    state.raw.index = 33 * SPACING
    api.syncFromRaw()

    expect(api.index.value).toBe(33)
    expect(api.settledIndex.value).toBe(0)

    api.settle()
    expect(api.settledIndex.value).toBe(33)
  })

  it('resets to an empty readout when the modality has no slices at all', async () => {
    const sliceState = shallowRef<SliceState | null>(makeSliceState({ index: 7, max: 40 }))
    const { api } = mountControl(shallowRef(makeScene(true)), sliceState, instantRun())
    expect(api.index.value).toBe(7)

    sliceState.value = null
    await Promise.resolve()

    expect(api.index.value).toBe(0)
    expect(api.max.value).toBe(0)
    expect(api.settledIndex.value).toBe(0)
  })

  it('does nothing at all once its owning component has unmounted', () => {
    const state = makeSliceState({ index: 10 })
    const { wrapper, api, el } = mountControl(shallowRef(makeScene(true)), shallowRef(state), instantRun())

    wrapper.unmount()
    el.dispatchEvent(pointer('pointerdown', { clientY: 0 }))
    el.dispatchEvent(pointer('pointermove', { clientY: 400 }))

    expect(api.index.value).toBe(10)
  })
})
