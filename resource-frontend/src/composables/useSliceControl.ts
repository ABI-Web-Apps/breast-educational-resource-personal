import type { Ref } from 'vue'
import type { CopperScene } from './copper-types'
import type { SliceState } from './useModalityScene'
import { beginGesture } from './copperExtras'
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'

/**
 * Slice scrubbing (design doc §7.5 and §11's `[`/`]` binding).
 *
 * The legacy implementation (frontend/plugins/copper.js:68-129) moved the
 * slice by exactly ±1 spacing per pointermove regardless of how far the
 * pointer had actually travelled, so the feel had nothing to do with the
 * gesture, and it added/removed its own `pointerdown` listener from inside
 * `pointermove` on every raycast miss. Here the drag distance drives the
 * slice DIRECTLY and proportionally -- one pointermove, one repaint, no
 * easing in between -- and the listeners are attached exactly once.
 *
 * An earlier version set a target and let an eased follower chase it. It
 * looked smoother in isolation and felt wrong in the hand: the image visibly
 * lagged the pointer, which is unacceptable for an instrument the reader is
 * using to look for something. The human's words were: why doesn't the
 * slice update in real time as the mouse moves? The follower survives only
 * for the `[`/`]` keys, where a
 * discrete step genuinely does read better as a short glide than a jump.
 *
 * Three things this file deliberately does not do:
 *
 *  · It owns no animation loop. The follower runs on `run`, which is
 *    useCameraChoreography's `animate` (Task 10 controller correction C8):
 *    one interruptible, reduced-motion-aware, lease-owning driver for the
 *    whole app. Injected rather than imported so this file cannot quietly
 *    become a second one.
 *  · It does not announce every value it passes through. `index` changes on
 *    every frame of an eased scrub; `settledIndex` changes only when the
 *    scrub stops, and that is what the screen-reader live region is bound to
 *    (controller correction C11 -- a live region on the per-frame value
 *    queues one utterance per frame and makes the app unusable with a
 *    screen reader on).
 *  · It does not scrub every drag. A drag that does not START on the slice
 *    plane belongs to OrbitControls, exactly as in the legacy app.
 */

/** useCameraChoreography's `animate`, injected. See the header. */
export type AnimateFn = (durationMs: number, onFrame: (easedT: number) => void) => Promise<void>

/** Slice numbers per pixel of vertical drag. At 0.25 a full 400px stage
 * height sweeps 100 slices, roughly the depth of this catalogue's volumes
 * (`MaxIndex` runs 27-104), so one full-height drag traverses the volume. */
const SENSITIVITY = 0.25

/** How long the follower takes to reach a newly set target. Short enough
 * that a drag does not feel detached from the pointer, long enough that a
 * single `[`/`]` step reads as motion rather than a jump. */
const FOLLOW_MS = 180

function clamp(value: number, max: number) {
  return Math.min(max, Math.max(0, value))
}

export function useSliceControl(
  host: Ref<HTMLElement | undefined>,
  scene: Ref<CopperScene | undefined>,
  sliceState: Ref<SliceState | null>,
  run: AnimateFn,
) {
  /** The displayed slice number: rounded, updated every frame. */
  const index = ref(0)
  const max = ref(0)
  /** The last value the scrub actually came to rest on -- see the header. */
  const settledIndex = ref(0)

  /**
   * The follower's own fractional position. Kept separate from `index`
   * on purpose: an earlier draft used the rounded `index` as the
   * follower's current value, which made the follower unable to converge
   * at all once the remaining distance dropped below one slice (the eased
   * step rounded back to the value it started from, and the loop spun
   * forever holding the continuous-render lease).
   */
  let current = 0
  let target = 0
  /** Bumped on every `follow()`; guards the settle announcement against a
   * superseded follow's own promise resolving later. */
  let followToken = 0

  let dragging = false
  let lastY = 0
  /** Releases the camera suppression a scrub holds; see `onPointerDown`. */
  let releaseCamera: (() => void) | null = null

  /**
   * `repaint()` is expensive: copper3d re-extracts the whole plane out of the
   * volume in JS and redraws its backing canvas
   * (three's `Volume.extractPerpendicularPlane`), then the
   * texture is re-uploaded on the next render. On this catalogue's larger
   * MRI volumes that is hundreds of thousands of iterations per call, so how
   * OFTEN it is called is the whole performance story of a scrub.
   *
   * Two things keep it down, and both matter:
   *
   *  · The index is ROUNDED to a whole slice. Only whole slices exist --
   *    copper3d floors the value on the way in -- so a fractional index costs
   *    a full repaint to display the picture that was already on screen. At
   *    `SENSITIVITY` 0.25 that is three wasted repaints out of every four
   *    pixels of drag.
   *  · Nothing is repainted when the slice number has not changed.
   */
  function applyIndex(next: number) {
    const state = sliceState.value
    if (!state) return
    const clamped = Math.round(clamp(next, state.max))
    if (clamped === current && index.value === clamped) return
    current = clamped
    // `raw.index` is a WORLD coordinate, `clamped` a slice number
    // (copper-types.ts's NrrdSlice doc).
    state.raw.index = clamped * state.raw.volume.spacing[2]!
    state.raw.repaint.call(state.raw)
    index.value = clamped
    /**
     * LOAD-BEARING under on-demand rendering: a repaint is not a frame. This
     * redraws the slice's backing canvas, and without asking for a frame the
     * new texture is simply never uploaded -- the stage keeps showing the
     * previous slice until something else happens to draw.
     *
     * Every writer of the slice index used to ride someone else's render
     * source: a drag rode useCopperStage's input pump, `[`/`]` rides the
     * animation driver's lease. That pump is gone (copper3d 3.9.0's
     * `updateOnInput` replaced it for the CAMERA), and a scrub suppresses
     * rotation for its whole gesture anyway, so the controls dispatch no
     * `change` and nothing else was left to schedule the frame. Requesting it
     * here makes every path self-sufficient rather than dependent on which
     * other subsystem happens to be running.
     */
    scene.value?.requestRenderIfNotRequested()
  }

  /**
   * Coalesces a burst of pointermoves into ONE repaint per displayed frame.
   * A high-polling mouse delivers well over 100 moves a second; without this
   * every one of them paid the full `repaint` cost above, and only the last
   * one before each frame was ever seen. The human's report was simply
   * that the rendering was far too slow.
   *
   * This is a single-frame coalescer, NOT a second animation loop -- it
   * schedules at most one callback, holds no lease, and cancels on detach.
   * The app's one-animation-driver rule is about competing rAF *loops*; this
   * has no continuation.
   */
  let pending: number | null = null
  let coalesceRaf: number | null = null

  function scheduleIndex(next: number) {
    pending = next
    if (coalesceRaf !== null) return
    coalesceRaf = requestAnimationFrame(() => {
      coalesceRaf = null
      if (pending === null) return
      applyIndex(pending)
      pending = null
      // Deliberately NOT `settle()`. `settledIndex` is what the screen-reader
      // live region is bound to (controller correction C11): announcing it
      // per frame queues one utterance per frame and makes the stage unusable
      // with a screen reader on. A drag announces once, from `endDrag`.
    })
  }

  function cancelScheduled() {
    if (coalesceRaf !== null) cancelAnimationFrame(coalesceRaf)
    coalesceRaf = null
    pending = null
  }

  function follow() {
    const token = ++followToken
    const from = current
    const to = target
    if (Math.abs(to - from) < 1e-3) {
      settledIndex.value = index.value
      return
    }
    run(FOLLOW_MS, t => applyIndex(from + (to - from) * t))
      .then(() => {
        // `run` resolves on interruption as well as on completion, so this
        // announces wherever the scrub actually stopped rather than
        // assuming it reached `to`. The token check drops the announcement
        // entirely when a newer follow has already superseded this one.
        if (token === followToken) settledIndex.value = index.value
      })
      .catch(() => {
        // A frame callback that throws is already surfaced by the driver;
        // there is nothing useful to do with it here, and letting it escape
        // would raise an unhandled rejection on every failed scrub.
      })
  }

  /**
   * Whether a pointer event lands on the slice plane. Decided ONCE per
   * gesture, at pointerdown -- unlike the legacy version, which re-raycast
   * on every move and could therefore change its mind mid-drag. Coordinates
   * are measured against the container's own rect because that is what
   * copper3d's raycaster divides by; the array argument is not optional
   * either. Both are explained on `CopperScene.pickSpecifiedModel`.
   */
  function hitsSlicePlane(event: PointerEvent, el: HTMLElement): boolean {
    const state = sliceState.value
    const target3d = scene.value
    if (!state || !target3d?.pickSpecifiedModel) return false
    const rect = el.getBoundingClientRect()
    const hit = target3d.pickSpecifiedModel([state.mesh], {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
    return Boolean(hit.intersectedObject)
  }

  function onPointerDown(event: PointerEvent) {
    const el = host.value
    if (!el || !sliceState.value || event.button !== 0 || !event.isPrimary) return
    if (dragging || !hitsSlicePlane(event, el)) return

    dragging = true
    lastY = event.clientY
    target = current
    // Stays `pointer` for the whole gesture, exactly as the legacy app did
    // (frontend/plugins/copper.js:78). An earlier version switched to
    // `ns-resize` on press to advertise the axis; the human read the change
    // itself as a glitch -- the cursor must not move under the hand
    // mid-gesture.
    el.style.cursor = 'pointer'

    // This handler runs in the CAPTURE phase specifically so this write
    // lands before the trackball sees the same pointerdown: its listener is
    // on the canvas (a descendant of `host`) in the bubble phase, and it
    // latches its rotate state during that handler. Suppressing rotation
    // afterwards would be one gesture too late, and the drag would both
    // scrub and orbit -- exactly what the legacy app avoided by setting the
    // same property at the same moment (frontend/plugins/copper.js:80).
    //
    // `beginGesture` restores whatever was there rather than re-enabling:
    // the 2D ultrasound modality ships with rotation already off
    // (useModalityScene's `flat` branch), and unlocking it here would make
    // the one flat modality orbitable for the rest of the session.
    const controls = scene.value?.controls
    if (controls) releaseCamera = beginGesture(controls)
    // No `setPointerCapture` here: the controls capture the pointer on the
    // canvas during the same gesture, and whichever element captures last
    // wins. Their capture keeps delivering moves to the canvas, which bubble
    // up to `host` regardless, so competing for the capture would buy
    // nothing and lose to it anyway.
  }

  function onPointerMove(event: PointerEvent) {
    const state = sliceState.value
    const el = host.value
    if (!state || !el) return

    if (!dragging) {
      // Hover affordance (human requirement #5). Nothing about a flat grey
      // rectangle says "drag me vertically", and the slice plane is the only
      // object on an imaging stage that responds to one. Raycast per move,
      // the same thing the legacy app did (frontend/plugins/copper.js:98) --
      // and only while a volume is loaded, so anatomy pays nothing.
      el.style.cursor = hitsSlicePlane(event, el) ? 'pointer' : ''
      return
    }

    const dy = event.clientY - lastY
    lastY = event.clientY
    // Not handed to the follower: the plane must track the pointer with no
    // perceptible lag. Coalesced to one repaint per frame, because repaint
    // is the expensive part -- see `scheduleIndex`.
    target = clamp(target + dy * SENSITIVITY, state.max)
    scheduleIndex(target)
  }

  function endDrag() {
    if (!dragging) return
    dragging = false
    // Any frame the pointer-up beat: apply it before announcing, so the
    // number read out is the one on screen.
    if (pending !== null) applyIndex(pending)
    cancelScheduled()
    settle()
    // Cleared rather than restored to `pointer`: the next pointermove
    // re-decides from an actual raycast, and the pointer may well have left
    // the plane during the drag.
    if (host.value) host.value.style.cursor = ''
    releaseCamera?.()
    releaseCamera = null
  }

  /** §11: `[` and `]` step the slice on the focused stage. */
  function onKeydown(event: KeyboardEvent) {
    const state = sliceState.value
    if (!state) return
    const delta = event.key === ']' ? 1 : event.key === '[' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    target = clamp(Math.round(target) + delta, state.max)
    follow()
  }

  /**
   * Leaving the stage entirely. The pointer stops producing `pointermove`
   * the moment it crosses out, so nothing else would ever clear the `pointer`
   * cursor or an in-flight drag's `noRotate` -- the viewer would be left
   * permanently un-rotatable with a hand cursor, which is what the human
   * reported. `pointerup` outside the stage has the same shape, and
   * `endDrag` covers both.
   */
  function onPointerLeave() {
    // `endDrag` restores rotation to whatever it was BEFORE the scrub,
    // which is the only correct restore: on the flat 2D modalities rotation
    // was already locked by useModalityScene and must stay locked. Nothing
    // here may unlock it unconditionally.
    endDrag()
    if (host.value) host.value.style.cursor = ''
  }

  function attach() {
    const el = host.value
    if (!el) return
    el.addEventListener('pointerdown', onPointerDown, true)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', endDrag)
    el.addEventListener('pointercancel', endDrag)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('keydown', onKeydown)
  }

  function detach() {
    const el = host.value
    if (!el) return
    el.removeEventListener('pointerdown', onPointerDown, true)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', endDrag)
    el.removeEventListener('pointercancel', endDrag)
    el.removeEventListener('pointerleave', onPointerLeave)
    el.removeEventListener('keydown', onKeydown)
    endDrag()
  }

  /** Keeps the readout in step with whatever `locateLesion` (or any other
   * writer of `raw.index`) has done to the slice, without this composable
   * having to own that motion itself. Deliberately does not touch
   * `settledIndex`: a caller driving an animation frame by frame calls this
   * every frame, and `settle()` once at the end. */
  function syncFromRaw() {
    const state = sliceState.value
    if (!state) return
    current = state.raw.index / state.raw.volume.spacing[2]!
    target = current
    index.value = Math.round(current)
  }

  /** Publishes the current value to the screen-reader readout. */
  function settle() {
    settledIndex.value = index.value
  }

  /**
   * Jumps straight to `sliceNumber` -- no glide. This is what "Locate lesion"
   * does now that no camera or slice animation survives on this stage (see
   * CopperStage's `onLocate`).
   *
   * `target` is moved with `current` so a subsequent drag starts from where
   * the plane actually is; leaving it behind would make the first drag after
   * a jump snap back to the pre-jump index.
   */
  function jumpTo(sliceNumber: number) {
    if (!sliceState.value) return
    // `applyIndex` requests the frame; see its own comment for why that
    // matters here. This was the first path to need it -- clicking "Locate
    // lesion" produced no reaction at all until the reader next rotated the
    // view, and only then did it jump to that slice.
    applyIndex(sliceNumber)
    target = current
    settle()
  }

  watch(sliceState, (state) => {
    if (!state) {
      index.value = 0
      max.value = 0
      settledIndex.value = 0
      current = 0
      target = 0
      return
    }
    max.value = state.max
    // Fix round 1, Important: seeded from the plane's actual position, via
    // the same `syncFromRaw` every other reader uses. Switching back to a
    // cached scene restores the very `SliceState` object stored at load
    // time, and nothing repaints that scene on the way in, so anything
    // captured at load time is a stale copy of where the plane really is by
    // then -- see `SliceState`'s own doc.
    syncFromRaw()
    settledIndex.value = index.value
  }, { immediate: true })

  /**
   * `await nextTick()` is LOAD-BEARING, for the same reason it is in
   * useCopperStage's own mount hook: the template ref this composable is
   * handed is NOT bound yet when `onMounted` fires, so `attach()` read
   * `host.value === undefined`, returned early, and silently attached
   * nothing. Every pointer listener below -- the hover cursor, the scrub,
   * the rotation lock -- was dead in a real browser from the day this was
   * written. No unit test could see it: they all pass a real element in
   * directly, so `attach()` finds one and the tests exercise handlers that
   * production never wired up.
   */
  /**
   * Attached TWICE, deliberately, and the second call is the load-bearing
   * one.
   *
   * The template ref this composable is handed is not bound yet when
   * `onMounted` fires -- the same trap useCopperStage documents. `attach()`
   * read `host.value === undefined`, returned early, and silently registered
   * nothing: the hover cursor, the scrub and the rotation lock were all dead
   * in a real browser from the day this was written, and no unit test could
   * see it because they all pass a real element in directly.
   *
   * Calling it again after `nextTick` fixes that. Calling it BEFORE as well
   * costs nothing and keeps the synchronous path working for callers that do
   * have an element at mount: `addEventListener` ignores a repeat
   * registration of the same type, callback and capture flag, so whichever
   * call finds the element first wins and the other is a no-op.
   */
  onMounted(() => {
    attach()
    void nextTick(attach)
  })
  onScopeDispose(detach)

  return { index, max, settledIndex, syncFromRaw, settle, jumpTo, attach, detach }
}
