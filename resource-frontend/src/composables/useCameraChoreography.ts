import type { Ref } from 'vue'
import { easeInOutCubic, orbitStepPose, zoomPose } from './copperExtras'
import type { Pose } from './copperExtras'
import type { CopperScene, NrrdSlice, StageApi, Vec3 } from './copper-types'
import { onMounted, onScopeDispose, ref } from 'vue'

/**
 * Camera choreography (design doc §7): the entrance orbit and the
 * modality-flight primitive, built as an interruptible, reduced-motion-aware
 * driver on top of Task 7's `requestContinuous`/`releaseContinuous` and
 * Task 8's per-modality scene cache.
 *
 * Controller correction C1 (task-9-brief.md): every camera mutation below
 * goes through exactly the four members `CopperCamera` (copper-types.ts)
 * declares -- `position.set`, `up.set`, `lookAt`, `updateProjectionMatrix`.
 * No `three` object of any kind crosses into or out of this file; all the
 * actual interpolation math lives in `cameraTransitions.ts` as pure
 * functions over plain `[x, y, z]` tuples.
 */

/** Reads copper3d's own Vec3-shaped object out as a plain tuple. Never used
 * to construct a foreign vector instance -- only to hand plain numbers to
 * this file's pure helpers and back out through `.set()`. */
function tuple(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z]
}

export interface LocateLesionOptions {
  durationMs?: number
  /** §7.2's camera push-in, as an ABSOLUTE orbit radius (not a factor).
   * Ignored when the camera is already closer than this -- see
   * `locateLesion`. Omit it to glide the slice with no camera motion. */
  dollyTo?: number
  /** Receives the (fractional) slice number every frame, so a UI readout
   * follows the glide instead of jumping only once it lands. */
  onIndex?: (index: number) => void
}

export function useCameraChoreography(stage: StageApi, scene: Ref<CopperScene | undefined>) {
  /** Design doc §7: reduced-motion collapses every animation to instant
   * (flyTo) or skips it entirely (orbitIntro, controller correction C6).
   * tokens.css's global reduced-motion guard is CSS-only and does not reach
   * this JS-driven camera motion -- this composable is the unguarded seam
   * design doc §7 calls out, so it owns its own media-query listener. */
  const prefersReducedMotion = ref(false)
  let mql: MediaQueryList | undefined
  const syncMotion = () => { prefersReducedMotion.value = !!mql?.matches }

  onMounted(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    syncMotion()
    mql.addEventListener('change', syncMotion)
  })
  // Review round 1, I-3: interrupting on dispose is this composable's own
  // responsibility, not something it should rely on useCopperStage's own
  // teardown to paper over. Without this, a component unmounting mid-orbit
  // (e.g. the user navigates to another case while the 3s entrance orbit is
  // still running) leaves the rAF chain rescheduling against a scene/camera
  // this composable no longer owns for as long as the animation had left to
  // run -- it happens to self-terminate today only because
  // useCopperStage.dispose() separately zeroes continuousHolders, which
  // this file neither knows about nor should depend on.
  onScopeDispose(() => {
    mql?.removeEventListener('change', syncMotion)
    interrupt()
  })

  let cancelCurrent: (() => void) | null = null

  /**
   * Any user input interrupts an in-flight animation. Controller correction
   * C3: this must stop the camera EXACTLY WHERE THE LAST FRAME LEFT IT, not
   * snap it to the animation's end pose -- jumping to the target the
   * instant a drag starts would fight the user's own input (and for
   * `orbitIntro` specifically, the old `onFrame(1)` behaviour mapped to
   * `sin(pi)=0`, teleporting back to the START pose mid-drag, which is
   * worse). A new animation started after an interrupt reads whatever pose
   * is current at that moment (see `flyTo`'s `currentPose()` call) and
   * flies FROM there, never from where an old animation was heading.
   */
  function interrupt() {
    cancelCurrent?.()
    cancelCurrent = null
  }

  /** Generic per-frame interpolation driver. Leases continuous rendering
   * for its own duration and always releases it -- on normal completion, on
   * interruption, and on a throwing frame callback.
   *
   * Review round 1, I-4: `interrupt()` runs unconditionally, BEFORE the
   * reduced-motion/instant-jump branch, not only on the animated path. A
   * running animation (e.g. `orbitIntro`) has its own rAF chain already
   * scheduled; without cancelling it here first, an instant `flyTo(pose, 0)`
   * (a §7.1 "cut", or reduced-motion toggled mid-orbit) would write its
   * destination pose and return, but the orbit's still-queued next frame
   * would fire right after and overwrite it -- the cut silently undone and
   * the orbit's lease outliving it. Every entry to `animate()` now takes
   * ownership of whatever was running, not just the animated one. */
  function animate(durationMs: number, onFrame: (easedT: number) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      interrupt()

      if (prefersReducedMotion.value || durationMs <= 0) {
        // Review round 1, M-8/M-9: this branch used to have no try/catch at
        // all, so a throwing `onFrame` would leave the promise permanently
        // unsettled (an `await camera.flyTo(...)` caller would hang
        // forever). Reject rather than resolve so a caller genuinely learns
        // the jump didn't land, matching the animated path's own failure
        // behaviour below.
        try {
          onFrame(1)
        }
        catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        stage.renderer.value?.render()
        resolve()
        return
      }

      stage.requestContinuous()
      const start = performance.now()
      let raf = 0
      let done = false

      const finish = () => {
        if (done) return
        done = true
        cancelAnimationFrame(raf)
        stage.releaseContinuous()
        cancelCurrent = null
        resolve()
      }

      // Review round 1, M-9: a throwing frame callback releases the lease
      // and REJECTS -- not `finish()` (which resolves) followed by a
      // rethrow that nothing downstream of a `requestAnimationFrame`
      // dispatch can catch. Without this, `await camera.flyTo(pose);
      // showHighlight()` would proceed as though the flight had landed.
      const fail = (err: unknown) => {
        if (done) return
        done = true
        cancelAnimationFrame(raf)
        stage.releaseContinuous()
        cancelCurrent = null
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      // C3: interrupting cancels in place. No `onFrame(1)` call here.
      cancelCurrent = finish

      const step = (now: number) => {
        let t: number
        try {
          t = Math.min(1, (now - start) / durationMs)
          onFrame(easeInOutCubic(t))
        }
        catch (err) {
          fail(err)
          return
        }
        if (t >= 1) finish()
        else raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    })
  }

  /** The look-at point every function in this file measures from --
   * `currentPose`, `interpolateFlightPose` (via `flyTo`), `orbitIntro`, and
   * `captureOrientation`/`applyOrientation` all pivot on `controls.target`,
   * falling back to the origin only when OrbitControls hasn't set one yet.
   * `captureOrientation`/`applyOrientation` used to hardcode the origin
   * instead (review round 1, I-2) -- harmless the first time a scene is
   * visited (a fresh scene's `controls.target` really is the origin), but
   * wrong on a repeat visit to a scene an earlier flight had already
   * re-aimed elsewhere. */
  function pivotOf(s: CopperScene | undefined): [number, number, number] {
    const t = s?.controls?.target
    return t ? tuple(t) : [0, 0, 0]
  }

  /**
   * Writes a `Pose` back through copper3d's own setters. The
   * `controls.target` write is the load-bearing half (Task 9 controller
   * correction C7): copper3d never syncs OrbitControls' `target` with
   * `camera.lookAt()`, so without it the user's next drag calls
   * `controls.update()`, which re-aims the camera at whatever `target` still
   * held (usually the origin) and silently unwinds whatever just moved the
   * camera. Every camera write in this file goes through here so that sync
   * can never be forgotten in one place and remembered in another.
   */
  function writePose(pose: Pose) {
    const cam = scene.value?.camera
    if (!cam) return
    cam.position.set(pose.position[0], pose.position[1], pose.position[2])
    cam.up.set(pose.up[0], pose.up[1], pose.up[2])
    cam.lookAt(pose.target[0], pose.target[1], pose.target[2])
    cam.updateProjectionMatrix()
    scene.value?.controls?.target?.set(pose.target[0], pose.target[1], pose.target[2])
  }

  /** Reads the current scene's camera pose (and OrbitControls target, if
   * any) as a plain `Pose` -- used as a flight's starting point. */
  function currentPose(): Pose | null {
    const cam = scene.value?.camera
    if (!cam) return null
    return {
      position: tuple(cam.position),
      up: tuple(cam.up),
      target: pivotOf(scene.value),
    }
  }

  /*
   * §7.3's `flyTo` (inter-modality camera flight) and §7.4's `orbitIntro`
   * (entrance orbit) were built here and then DELETED at the human's
   * explicit instruction: remove every rotation animation on the models
   * and on the images -- and, asked separately about the flight, remove
   * that as well and switch instantly. Both moved the camera
   * away from wherever the reader had put it, which is precisely what they
   * did not want. §7.2's camera push-in went with them (see
   * CopperStage's `onLocate`).
   *
   * What is left in this file is not camera choreography any more: it is the
   * single animation driver (`animate`/`interrupt`), which the §7.1 density
   * CROSSFADE and the slice follower still share, plus the two instant
   * keyboard camera steps below. Nothing here moves the camera on its own
   * initiative -- every remaining writer is responding to a key press.
   */

  /**
   * §11 keyboard camera control. Both of these are deliberately INSTANT
   * rather than eased: a key press is a discrete step, and easing each one
   * over even 150ms makes a held arrow key visibly lag its own repeats. They
   * still take ownership of whatever animation was running (`interrupt`),
   * because a key press is user input and §7.4 hands control back on any
   * input, and they still write through `writePose` so `controls.target`
   * stays in sync.
   */
  function nudgeOrbit(yawRad: number, pitchRad: number) {
    const from = currentPose()
    if (!from) return
    interrupt()
    writePose(orbitStepPose(from, yawRad, pitchRad))
    stage.renderer.value?.render()
  }

  function zoomBy(factor: number) {
    const from = currentPose()
    if (!from) return
    interrupt()
    writePose(zoomPose(from, factor))
    stage.renderer.value?.render()
  }

  /**
   * Tour-only: an eased yaw sweep around the current pivot.
   *
   * NOT `nudgeOrbit` in a loop -- that calls `interrupt()` on every call, so
   * inside `animate`'s frame callback it would cancel the very animation
   * driving it on the first frame. This computes each frame absolutely from
   * the pose it started at, so it neither drifts nor fights the driver.
   *
   * This is the single exception to "no automatic camera animation" (design
   * doc D7): it runs only while the tour is active, and the caller restores
   * the entry pose with `applyPose` when the step ends, the user takes over,
   * or the tour exits.
   */
  function orbitBy(yawRad: number, durationMs: number): Promise<void> {
    const from = currentPose()
    if (!from) return Promise.resolve()
    return animate(durationMs, (t) => {
      writePose(orbitStepPose(from, yawRad * t, 0))
    })
  }

  /** Writes a pose back verbatim, taking ownership of anything in flight.
   *  Used to restore the reader's own framing after a tour demo. */
  function applyPose(pose: Pose) {
    interrupt()
    writePose(pose)
    stage.renderer.value?.render()
  }

  return {
    prefersReducedMotion,
    /**
     * Task 10 controller correction C8: the density crossfade (§7.1) is an
     * opacity animation, not a camera one, but it needs exactly the four
     * things this driver already owns -- reduced-motion collapse to a direct
     * switch, interruptibility, a guaranteed continuous-render lease release
     * on a throwing frame, and cancellation on scope disposal. Exposing the
     * driver itself is the smallest change that lets the crossfade reuse
     * them; forking a second rAF loop for it would have cost all four at
     * once. This does NOT weaken the single-driver property -- there is
     * still exactly one `cancelCurrent` slot and one lease owner, and every
     * animation in the app still passes through here.
     */
    animate,
    nudgeOrbit,
    zoomBy,
    orbitBy,
    applyPose,
    interrupt,
    currentPose,
  }
}
