import type { Ref } from 'vue'
import type { CopperModule, CopperRenderer, StageApi } from './copper-types'
import { loadCopper3d } from './copper3dModule'
import { nextTick, onMounted, onScopeDispose, ref, shallowRef } from 'vue'

/**
 * Lifecycle of the single renderer (design doc §8.2).
 *
 * The legacy implementation built three copperRenderers at the module
 * scope of plugins/copper.js and called animate() on all three, so three
 * WebGL contexts and three permanent rAF loops existed unconditionally.
 * Here there is one copperRendererOnDemond, bound to the component
 * lifecycle: no frames while idle.
 *
 * Camera animations temporarily promote rendering to continuous via
 * requestContinuous(), and fall back to on-demand via releaseContinuous()
 * once they finish (design doc §7.6).
 */
/**
 * Imports copper3d through the shared, memoized loader.
 *
 * The `document.currentScript` shim that makes the import possible at all --
 * and why it is needed -- lives in `copper3dModule.ts`, which is also what
 * `copperExtras` reads from. One import, one shim, one cached module.
 */
async function importCopper3d(): Promise<CopperModule> {
  return (await loadCopper3d()) as unknown as CopperModule
}

// useCopperStage(host, options)
export interface StageOptions {
  /**
   * Called on every container resize with the host's measured box.
   *
   * A mutable hook rather than a constructor argument because its only
   * caller lives in `useModalityScene`, which is built FROM this stage --
   * so at the moment `useCopperStage` is called there is nothing to pass.
   * `CopperStage` assigns it on the next line, before any resize can fire.
   */
  onResize?: (box: { width: number, height: number }) => void
}

export function useCopperStage(host: Ref<HTMLElement | undefined>, options: StageOptions = {}): StageApi {
  const renderer = shallowRef<CopperRenderer>()
  const Copper = shallowRef<CopperModule>()
  const ready = ref(false)
  const loadError = shallowRef<Error>()

  let continuousHolders = 0
  let rafId: number | null = null

  // Set once by onScopeDispose. `renderer.value === undefined` is NOT a
  // reliable "already torn down" signal on its own: it's also true before
  // the renderer has been built yet, which is exactly the window fix #1
  // below has to guard. `disposed` is the actual, unambiguous state flag.
  let disposed = false
  // Set once onScopeDispose runs, checked after the dynamic import's
  // `await` resolves (review fix #1). baseRenderer's constructor creates
  // a live THREE.WebGLRenderer -- a real GPU context -- before it can ever
  // fail on a null container, so constructing after the component has
  // already unmounted (its host div gone, nothing left to call dispose())
  // would leak an unowned, never-freed WebGL context. Browsers cap live
  // contexts around 16; a few rapid case switches during a slow chunk
  // load would exhaust that budget.
  let cancelled = false

  function tick() {
    if (disposed) return
    renderer.value?.render()
    rafId = requestAnimationFrame(tick)
  }

  /** Call when an animation starts. Re-entrant: concurrent animations still
   * share a single rAF loop. No-ops after disposal (review fix #2): without
   * this, a Task 9/10 animation timer firing after unmount would start a
   * fresh rAF loop with no owner left to ever call releaseContinuous(). */
  function requestContinuous() {
    if (disposed) return
    continuousHolders++
    if (rafId === null) rafId = requestAnimationFrame(tick)
  }

  /** Call when an animation ends. Frames stop once the count returns to 0.
   * Also a no-op after disposal, for symmetry with requestContinuous --
   * there is nothing left to release. */
  function releaseContinuous() {
    if (disposed) return
    continuousHolders = Math.max(0, continuousHolders - 1)
    if (continuousHolders === 0 && rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
      // One more render on the way back to on-demand, so the view settles
      // on its final state rather than whatever the last rAF frame drew.
      renderer.value?.render()
    }
  }

  let resizeObserver: ResizeObserver | undefined

  /**
   * The host's current width / height, for `fitView`'s `fitDistance`.
   * Measured fresh on every call rather than cached off the ResizeObserver:
   * `refitCurrentScene` also runs right after a load, on a scene the
   * observer has not necessarily fired for yet. Returns 1 for a box this
   * function cannot trust -- not yet laid out, or momentarily 0×0 mid panel
   * collapse -- rather than 0 or `Infinity`, either of which would corrupt
   * the camera's projection matrix downstream.
   */
  function aspect(): number {
    const box = host.value?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return 1
    return box.width / box.height
  }

  onMounted(async () => {
    // No `window`, no WebGL: nothing to build. (Vitest's happy-dom does
    // provide a `window`, so the guarded path still runs under test.)
    if (typeof window === 'undefined') return

    // `host` is NOT bound yet when this hook fires. Verified in a real
    // browser: `onMounted` sees `host.value === undefined`, and the very
    // next tick sees it bound -- the stage host is patched in a later flush
    // than this component's own mount, under the page's Suspense boundary.
    //
    // Without this await the guard below returned on EVERY page load and
    // the renderer was never constructed, silently: an early return sets
    // neither `ready` nor `loadError`, so the stage showed no canvas, no
    // spinner and no error message. Every 3D test on this branch mocks
    // copper3d and passes the host element in directly, so not one of them
    // could see it. Only a real browser could.
    await nextTick()
    if (cancelled || !host.value) return

    let mod: CopperModule
    let built: CopperRenderer
    try {
      // copper3d touches window/document, so it must be dynamically
      // imported on the client only. Construction is inside the same
      // try/catch (round-2 review fix #1): `new WebGLRenderer` throws
      // whenever WebGL is unavailable (GPU blocklist, WebGL disabled, the
      // ~16-context browser budget already exhausted), and
      // `baseRenderer`'s constructor also calls
      // `PMREMGenerator.compileEquirectangularShader()`, another throw
      // site -- both would otherwise leave `ready` false and `loadError`
      // unset forever, the exact permanently-blank-stage-plus-unhandled-
      // rejection state fix #7 existed to eliminate.
      //
      // Nothing this call site can reach needs disposing on that path, but
      // that is not the same as nothing existing: if `new WebGLRenderer`
      // succeeds and the later `compileEquirectangularShader()` throws, a
      // live GPU context was already created and assigned to the instance
      // `new` then discards. JS gives no access to a constructor's `this`
      // after it throws, so that context is unreachable and released only
      // by GC -- an upstream constraint, not something fixable here.
      mod = await importCopper3d()
      // The component may have unmounted while that chunk was still
      // downloading -- see `cancelled`'s comment above. Checking before
      // ever calling `new` means no renderer, and therefore no GPU
      // context, is built at all in that case; there is nothing to
      // dispose because nothing was constructed.
      if (cancelled || !host.value) return
      built = new mod.copperRendererOnDemond(host.value as HTMLDivElement, {
        guiOpen: false,
        alpha: true, // background is CSS-driven (design doc §5.3)
        logarithmicDepthBuffer: true,
        // Deliberately NOT passing `light` or `controls` here: baseRenderer's
        // constructor reads only `alpha`, `logarithmicDepthBuffer` and
        // `guiOpen` from these options, and the `copperSceneOnDemond` scenes
        // this renderer builds take their controls per scene, from
        // `createScene(name, { controls })` (see useModalityScene), never
        // from the renderer's own `options.controls`. Passing either here
        // would be silently inert, not a real toggle -- see copper-types.ts's
        // CopperControls.
      })
    }
    catch (err) {
      // Covers both the dynamic import rejecting (fix #7, original round)
      // and the constructor throwing (fix #1, this round).
      if (!cancelled) loadError.value = err instanceof Error ? err : new Error(String(err))
      return
    }
    // No repeat `cancelled`/`host.value` check here: nothing in this
    // function awaits between the check just before `new` above and this
    // line, so neither can have changed since.

    Copper.value = mod
    renderer.value = built
    ready.value = true

    // Review fix #5: copper3d only re-sizes its canvas on `window` resize,
    // but the desktop layout's panel-collapse (design doc §10.1) changes
    // this stage's own width with no window resize event at all -- so the
    // canvas would stretch to the wrong aspect ratio without this. This is
    // a ResizeObserver keeping a drawing surface in sync with a box CSS
    // already sized, not a layout decision, so it doesn't conflict with
    // this project's CSS-only-breakpoints rule.
    resizeObserver = new ResizeObserver(() => {
      // Round-2 review fix #4: a hidden (display:none) or momentarily
      // zero-width/height container -- e.g. a collapsing panel mid-
      // transition -- makes onRenderCameraChange's aspect = width/height
      // compute 0/0 = NaN, corrupting the camera's projection matrix.
      // Bail before touching the scene at all in that case.
      if (!host.value) return
      const { width, height } = host.value.getBoundingClientRect()
      if (width === 0 || height === 0) return
      const current = renderer.value?.getCurrentScene()
      current?.onWindowResize()
      // TrackballControls caches the canvas's page-relative box in `screen`
      // and recomputes it ONLY here -- unlike OrbitControls, which measures
      // per pointer event. Skip this and every drag after a panel collapse
      // or a window resize is computed against stale bounds, so the model
      // swings off-axis. Guarded rather than asserted: `getCurrentScene()`
      // can still be the renderer's placeholder `baseScene`, which has no
      // controls at all (see CopperBaseScene).
      ;(current as { controls?: { handleResize?: () => void } }).controls?.handleResize?.()
      renderer.value?.render()
      // Task 3 (three-up plan): a panel resize is exactly when a scene still
      // showing its opening framing needs to be refitted -- see
      // ts/Controls/fitView.ts.
      // `useModalityScene` does not exist yet at the point `useCopperStage`
      // is constructed (it is built FROM this stage), so this is a mutable
      // hook rather than a value read once here -- see `StageOptions`.
      options.onResize?.({ width, height })
    })
    resizeObserver.observe(host.value)

    /**
     * Camera input needs no frame pump here, as of copper3d 3.9.0.
     *
     * It used to. `Copper3dTrackballControls` dispatches `change` only from
     * inside its `update()`, and `update()` only runs inside
     * `scene.render()` -- under on-demand rendering that closes a deadlock:
     * no render, so no update, so the camera never moves, so no `change`, so
     * nothing requests a render, and the viewer is dead to the mouse. This
     * composable worked around it by listening for pointer and wheel input
     * and requesting a frame itself.
     *
     * 3.9.0 fixes it at the source with `updateOnInput`, which
     * `copperSceneOnDemond` turns on for the scenes it builds with
     * `{ controls: "copper3d" }`. The input handlers now move the camera and
     * dispatch `change` themselves, and the scene's own listener schedules
     * the frame. `test-browser/camera-drag.spec.ts` is what holds this --
     * the failure mode is invisible to every unit test.
     */
  })

  onScopeDispose(() => {
    cancelled = true
    disposed = true
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    continuousHolders = 0
    resizeObserver?.disconnect()
    resizeObserver = undefined
    renderer.value?.stop()
    renderer.value?.dispose()
    renderer.value = undefined
    ready.value = false
  })

  return { renderer, Copper, ready, loadError, requestContinuous, releaseContinuous, aspect }
}
