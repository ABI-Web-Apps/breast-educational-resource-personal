import { onScopeDispose, ref, shallowRef } from 'vue'
import { useAssetUrl } from '@/composables/useAssetUrl'
import { publicBase } from '@/runtime/env'
import type { Modality } from '@/content/types'
import type { CopperModule, CopperRenderer, CopperScene, CopperViewPoint, NrrdMesh, NrrdSlice, SceneObject, SceneObjectChild, StageApi } from './copper-types'
import type { FitBounds, SceneBudget } from './copperExtras'
import { getSceneBudget } from './sceneBudget'
import {
  addVolumeBoundingBox,
  collectFadeTargets,
  disposeObject3D,
  disposeScene,
  exposureExponent,
  fitView,
  installFastSliceRepaint,
  removeSceneFromMap,
  restoreFade,
  setDracoDecoderPath,
  setFade,
  setPanEnabled,
  setRotateEnabled,
} from './copperExtras'

/**
 * GLBs are all <=1.28MB (this app's four `density*.glb` anatomy assets --
 * checked their sizes directly), so a flat wall-clock timeout is fine for
 * them. It is a net under `loadGltf`'s `onError`, not a substitute for it:
 * it catches a connection that neither completes nor fails.
 */
const GLB_LOAD_TIMEOUT_MS = 30_000

/**
 * NRRD volumes run up to ~53MB (`cancer-lobular/right/mri.nrrd`, checked
 * directly) -- a flat wall-clock timeout on those misreports a slow-but-
 * healthy download as a failure (14.2 Mbps sustained for 30s to finish
 * that file; ~6 Mbps, a realistic shared-network speed, takes 71s). "No
 * progress for 15s" is a genuine stall signal a large-but-healthy transfer
 * won't trip, whereas a fixed deadline eventually will regardless of file
 * size. `loadNrrd`'s `onProgress` (copper3d 3.9.0) is what re-arms it;
 * before that existed, the only liveness signal copper3d exposed was the
 * text of its own loading bar, watched with a `MutationObserver`.
 */
const NRRD_STALL_TIMEOUT_MS = 15_000

/**
 * The fat layer's tint. NOT the legacy app's literal `#a3932a`
 * (LeftModel.vue:167), and the reason is arithmetic, not taste.
 *
 * At 40% opacity the layer composites with whatever is behind it, and the
 * legacy app's page background was `rgba(251,113,133)` -- a saturated coral
 * (assets/sass/global.scss:4). That is where the flesh tone the human
 * remembers actually came from:
 *
 *   0.4*(163,147,42) + 0.6*(251,113,133) = (216,127,97)  -- salmon
 *
 * This app's stage background is near-white (`#FBF7F8`), and the same layer
 * over it composites to
 *
 *   0.4*(163,147,42) + 0.6*(251,247,248) = (216,207,166)  -- khaki
 *
 * which is exactly the drab, dated colour the human reported, and is
 * reproduced
 * pixel-for-pixel by a screenshot of this app. Nothing is wrong with the
 * model or the material; the background changed underneath it.
 *
 * Solving for the colour that lands on a warm flesh (`#E8C4A8`) over THIS
 * background gives `#CB7830`. (Reproducing the legacy salmon exactly is
 * impossible here: solved over a near-white background at 40% it needs
 * negative green and blue. Raising the opacity instead would hide the
 * fibroglandular tissue underneath, which is the entire point of the layer
 * being translucent.)
 */
const FAT_LAYER_COLOR = '#CB7830'

export interface SliceState {
  /**
   * There is deliberately NO `index` field here (fix round 1, Important).
   * It existed, was computed once at load time, and was never written
   * again -- scrubbing and `locateLesion` both move `raw.index` instead --
   * so the moment a cached scene was revisited it was a stale copy of the
   * truth that `useSliceControl` then seeded its readout and its follower
   * from. `raw.index` (a world coordinate; divide by `volume.spacing[2]`)
   * is the only place the current slice lives. Do not reintroduce a second
   * copy: the bug is unrepresentable while there is only one.
   */
  max: number
  /** copper3d's own slice object, for useSliceControl (Task 10) to drive
   * directly. */
  raw: NrrdSlice
  /** The z-plane mesh the slice is painted on. useSliceControl raycasts
   * against it (§7.5) so a drag that starts on the slice scrubs and a drag
   * that starts on empty space orbits -- the same gate the legacy app used
   * (frontend/plugins/copper.js:90), which is the only thing that stops the
   * two gestures from firing at once on a shared canvas. */
  mesh: NrrdMesh
}

/**
 * §7.1's density crossfade, prepared but not yet run. Split into a
 * per-frame `apply` and a terminal `commit` so the actual animation can be
 * driven by useCameraChoreography's single driver (controller correction
 * C8) rather than by a second rAF loop in here.
 */
export interface AnatomyMorph {
  /** `t` runs 0 (only the outgoing model visible) -> 1 (only the incoming
   * one). Safe to call repeatedly and out of order. */
  apply: (t: number) => void
  /**
   * Settles on the incoming model and disposes the outgoing one. Snaps to
   * the end state rather than trusting the last `apply` to have reached
   * t=1, so an INTERRUPTED crossfade still ends on a fully-opaque model
   * instead of freezing two half-transparent ones on screen -- the driver
   * resolves its promise on interrupt as well as on completion.
   */
  commit: () => void
}

/**
 * A scene's decoded size, for the residency budget.
 *
 * NRRD: the volume's own typed array, which is the whole cost -- the slice
 * plane's canvas texture is one slice, kilobytes against megabytes.
 * GLB (slice === null): the anatomy models in this catalogue are 617KB to
 * 1.05MB on disk and decode to a similar order, so a flat estimate is
 * accurate enough to keep them from being free. Being wrong here changes
 * eviction order, not correctness.
 */
const GLB_ESTIMATED_BYTES = 2 * 1024 * 1024

function sceneBytes(slice: SliceState | null): number {
  const volume = slice?.raw.volume as { data?: { byteLength?: number } } | undefined
  const data = volume?.data
  return data?.byteLength ?? GLB_ESTIMATED_BYTES
}

/**
 * `injectedBudget` is resolved lazily rather than defaulted in the signature:
 * the shared budget is built by copper3d's `createSceneBudget`, and this
 * composable is constructed during `setup()`, before `useCopperStage`'s mount
 * hook has finished importing the library. Every real use of it happens after
 * a load, by which time the module is there.
 */
export function useModalityScene(stage: StageApi, injectedBudget?: SceneBudget) {
  let resolvedBudget: SceneBudget | undefined = injectedBudget
  const budget = () => (resolvedBudget ??= getSceneBudget())

  const { url } = useAssetUrl()
  /**
   * Where the self-hosted DRACO decoder lives (`public/draco/`), resolved
   * against the deployment base: a GitHub Pages subpath deploy asks for
   * `/te-uma/draco/` rather than `/draco/`, and the plugin build asks the
   * folder its own bundle was served from. three appends the file names to
   * this verbatim, applying no base of its own -- the same trap
   * `resolveAssetBase` exists for on the model URLs.
   */
  setDracoDecoderPath(`${publicBase().replace(/\/$/, '')}/draco/`)

  const scene = shallowRef<CopperScene>()
  const loading = ref(false)
  /** Real fractional progress for NRRD loads (parsed from copper3d's own
   * progress text -- see NRRD_STALL_TIMEOUT_MS's doc); GLB loads only ever
   * report 0 then 1, since `loadGltf` has no progress signal at all. */
  const progress = ref(0)
  /**
   * `shallowRef`, NOT `ref` -- and this is a performance correctness issue,
   * not a style preference.
   *
   * A deep `ref` hands its contents to Vue 3's reactive Proxy, and a
   * `SliceState` transitively contains `raw.volume.data`: the decoded NRRD,
   * a typed array of hundreds of thousands of voxels. Vue 3 proxies ANY
   * object, typed arrays included, so every single voxel read inside
   * copper3d's per-pixel repaint loop went through Vue's `get` trap.
   *
   * Measured with V8's sampling profiler while dragging the slice plane on
   * `/case/density-a/mri`: Vue's `get` (13.0%), `isRef` (10.1%), and its
   * shared helpers (4.9%) together accounted for ~29% of all CPU during a
   * scrub -- for a value nothing renders from.
   *
   * The legacy Vue 2 app never hit this: Vue 2's `observe()` walks only
   * arrays and plain objects, and a typed array is neither, so its voxel
   * data was left untouched. That is why the human reports the old MRI and
   * mammogram viewers as smooth.
   *
   * Shallow is also semantically right: a `SliceState` is replaced wholesale
   * on every load, and nothing reads its fields reactively -- the scrub
   * position is published through `useSliceControl`'s own `index` ref.
   */
  const sliceState = shallowRef<SliceState | null>(null)
  /** Set only when an asset genuinely fails to load (a stall/timeout, or
   * copper3d refusing to create a scene at all). Distinct from
   * `stage.loadError` (Task 7), which covers copper3d's own chunk failing
   * to import -- CopperStage renders both through the same pattern. */
  const loadError = shallowRef<Error>()
  /**
   * The raw view-preset JSON for the scene now current -- exposed as DATA,
   * not just applied instantly via `loadView` below. Task 9's controller
   * correction C2: copper3d has no public, importable `resolveViewPose`/
   * `orbitFraming` (the deep-importable file behind those names pulls in a
   * second, distinct copy of `three`, which is unusable here -- see
   * cameraTransitions.ts's header). A camera flight still needs *something*
   * to interpolate toward instead of only ever jumping straight there, and
   * this is the same preset data that would have fed those functions, so
   * nothing is lost by using it directly instead.
   */
  const viewpoint = shallowRef<CopperViewPoint>()

  /** Per-scene slice info, keyed by scene name, so switching back to a
   * cached NRRD scene restores its own slice position instead of showing
   * whichever scene last finished loading. */
  const sliceStateByScene = new Map<string, SliceState | null>()
  /** Per-scene view preset, mirroring sliceStateByScene: switching back to a
   * cached scene must restore ITS OWN preset, not whatever scene loaded
   * last. */
  const viewpointByScene = new Map<string, CopperViewPoint>()

  /** Each scene's object bounds, for `fitDistance`. NRRD gives this
   *  directly as `volume.RASDimensions`; a GLB is measured with a Box3. */
  const boundsByScene = new Map<string, FitBounds>()
  /**
   * Scenes the reader has moved the camera on.
   *
   * A refit on resize is right for a scene still showing its opening
   * framing and wrong for one the reader has posed -- there, it would
   * yank the view back every time a panel collapsed. `CopperStage` marks
   * this from every input that actually moves the camera: `pointerdown`/
   * `wheel` (`onUserInput`) and the arrow-key orbit/`+`/`-` zoom keyboard
   * equivalents (`onStageKeydown`) -- the keyboard path matters on its own,
   * not just as a fallback: a keyboard-only reader has no other way to pose
   * the camera at all, so missing it there silently discarded exactly that
   * reader's view on the next panel resize. `Reset view` clears it.
   */
  const posedScenes = new Set<string>()

  /**
   * Which anatomy GLB each scene currently DISPLAYS -- not which one its
   * name says it should. §7.1's density morph deliberately swaps the model
   * inside an existing scene without creating a new one, so the scene name
   * stops being a reliable answer the moment a morph has run. Controller
   * correction C12 needs this: `the-breast` and `density-a` ship the same
   * `density25.glb` (content/cases.ts:83 and :89), and crossfading a model
   * against a freshly downloaded copy of its own twin is 800ms of nothing.
   * Keyed by the scene object rather than by name for the same reason.
   */
  const anatomyAssetByScene = new Map<CopperScene, string>()

  /**
   * The `slug:modality` name each scene is registered under in copper3d's
   * own `sceneMap`. The reverse of that map, which copper3d does not
   * provide, and which is needed because §7.1's morph makes a scene's name
   * stop matching what it holds -- see `adoptSceneName`.
   */
  const nameOfScene = new Map<CopperScene, string>()

  /**
   * Scenes whose incoming morph model is still downloading. Two morphs on
   * one scene would both claim the same outgoing model as theirs: the
   * second would rename or remove a group the first is still fading.
   * Reachable by stepping density-b then density-c before the first
   * ~1.28MB GLB lands.
   */
  const morphingScenes = new Set<CopperScene>()

  // How many built scenes may stay resident, and which ones to evict first:
  // see sceneBudget.ts.

  /** Bumped on every `load()` call. Guards against a stale async result
   * (a slow network response, or a timeout/stall) landing after the user
   * has already switched to a different modality and overwriting
   * `loading`/`sliceState`/`loadError` with data for a scene that is no
   * longer current. */
  let loadToken = 0

  /** The scene this stage is currently showing, pinned in the budget so it
   *  can never be evicted out from under the reader -- see `touchScene` and
   *  `onScopeDispose`. */
  let pinnedName: string | undefined

  /** Set once this composable's owning scope (CopperStage's component
   * instance) is disposed -- e.g. case navigation. Mirrors useCopperStage's
   * own `disposed` flag: there is no way to cancel the in-flight XHR
   * inside loadGltf/loadNrrd, so a response can still arrive after
   * teardown. Checked before touching `next`/`renderer` again, since by
   * then `renderer` may be a disposed WebGLRenderer (`onWindowResize` ->
   * `setSize` on a dead context) and there is nothing left to update
   * anyway. */
  let disposed = false

  /**
   * Switches the renderer to `next` and hands control input over to it.
   * Review fix #1: every scene's OrbitControls listens on the *shared*
   * canvas regardless of which scene is "current", so leaving a previous
   * scene's controls enabled means its `change` handler still fires (and
   * still requests a render of *that* scene) on every drag/resize -- the
   * last-created scene wins the race and paints over whatever is actually
   * meant to be visible. Disabling the outgoing scene's controls and
   * enabling the incoming one is the only thing that actually stops that.
   */
  function activateScene(renderer: CopperRenderer, next: CopperScene) {
    const previous = scene.value
    if (previous && previous !== next) previous.controls.enabled = false
    next.controls.enabled = true
    renderer.setCurrentScene(next)
    scene.value = next
  }

  /**
   * A scene is identified by the ASSET it displays, not by the case that
   * happens to be showing it.
   *
   * This used to be `${slug}:${modality.id}`, which quietly decoded the
   * same file more than once. `the-breast` and `density-a` ship the same
   * three files (`density-1/left/density25.glb`,
   * `density-1/middle/m3d.nrrd`, `density-1/right/mri.nrrd`), so stepping
   * between them built a second scene per modality and paid for a second
   * copy of a 21MB volume -- which is what the human saw: The Breast and
   * density-A are exactly the same content, so just reuse it; why render
   * it twice? The same waste applied five times over to the lesion cases,
   * which all borrow `density-3/left/density75.glb` for their anatomy.
   *
   * `slug` stays in the signature because every call site has it and the
   * pairing reads correctly; it just does not contribute to identity.
   *
   * Two consequences worth knowing:
   *  - The residency budget now counts each distinct file once, which is
   *    what it was always trying to measure.
   *  - `prepareMorph` already declined to crossfade a model against its own
   *    twin by comparing asset URLs (controller correction C12); with names
   *    derived from the same URL, `adoptSceneName` is a no-op in exactly
   *    that case rather than a rename between two names for one file.
   */
  function sceneName(slug: string, modality: Modality) {
    return url(modality.asset)
  }

  /**
   * Drops a cached scene entirely: out of copper3d's map, out of this
   * composable's bookkeeping, and out of the GPU.
   *
   * `disposeScene` owns the library half -- unregistering, dropping the
   * `change` listener without touching the shared controls, and freeing
   * every child's geometry, material and textures. What stays here is this
   * composable's own bookkeeping, which copper3d knows nothing about.
   */
  function evictScene(renderer: CopperRenderer, name: string) {
    const victim = disposeScene(renderer, name)
    sliceStateByScene.delete(name)
    viewpointByScene.delete(name)
    boundsByScene.delete(name)
    posedScenes.delete(name)
    budget().release(name)
    if (!victim) return

    anatomyAssetByScene.delete(victim)
    nameOfScene.delete(victim)
  }

  /** Records `name` as most-recently-used and applies the budget. Called
   *  only once a scene genuinely holds content AND is the one the user is
   *  actually looking at -- a failed load is evicted by `load()`'s own
   *  catch instead, and a superseded load registers itself in `load()`
   *  without touching the queue. */
  function touchScene(renderer: CopperRenderer, scene: CopperScene, name: string) {
    nameOfScene.set(scene, name)
    budget().touch(name)
    // Whatever this stage is showing is off limits: three-up has up to
    // three of these composables live at once, and evicting a visible
    // scene to satisfy a soft byte budget would blank a panel the reader
    // is looking at.
    if (pinnedName && pinnedName !== name) budget().unpin(pinnedName)
    pinnedName = name
    budget().pin(name)
    for (const victim of budget().overflow()) evictScene(renderer, victim)
  }

  /**
   * Re-registers `target` under `nextName`.
   *
   * §7.1's morph swaps the model inside an existing scene and deliberately
   * suppresses `load()`, so after density-a -> density-b the live scene is
   * still registered as `density-a:anatomy`. Left alone, stepping to that
   * case's MRI and back would miss the cache, build a second scene, and
   * re-download a GLB already in memory -- while the original sat in
   * `sceneMap` under a name that no longer described it, for the life of
   * the renderer. The scene's name has to follow what it displays, exactly
   * as `anatomyAssetByScene` already makes its asset do.
   */
  function adoptSceneName(renderer: CopperRenderer, target: CopperScene, nextName: string) {
    const currentName = nameOfScene.get(target)
    if (currentName === nextName) return

    // A scene already registered under the destination name is stale by
    // definition: the one adopting the name is the one on screen. Two
    // scenes cannot share a key, and keeping the other would leak it.
    const occupant = renderer.getSceneByName(nextName)
    if (occupant && occupant !== target) evictScene(renderer, nextName)

    if (currentName !== undefined) {
      removeSceneFromMap(renderer,currentName)
      const slice = sliceStateByScene.get(currentName)
      if (slice !== undefined) {
        sliceStateByScene.set(nextName, slice)
        sliceStateByScene.delete(currentName)
      }
      const preset = viewpointByScene.get(currentName)
      if (preset !== undefined) {
        viewpointByScene.set(nextName, preset)
        viewpointByScene.delete(currentName)
      }
      const bounds = boundsByScene.get(currentName)
      if (bounds !== undefined) {
        boundsByScene.set(nextName, bounds)
        boundsByScene.delete(currentName)
      }
      if (posedScenes.has(currentName)) {
        posedScenes.delete(currentName)
        posedScenes.add(nextName)
      }
      // Carries the budget's bytes, queue position and pin state across --
      // the morphed scene held content (and, if on screen, the pin) under
      // `currentName` a moment ago, and holds content now too.
      budget().rename(currentName, nextName)
      if (pinnedName === currentName) pinnedName = nextName
    }
    else {
      // No previous name: this scene was never registered in the budget at
      // all (unreachable in practice -- a morph target always has one --
      // but kept so the scene is still counted rather than silently free).
      budget().register(nextName, GLB_ESTIMATED_BYTES)
    }

    renderer.sceneMap[nextName] = target
    // copper3d keeps its own copy on the instance
    // (dist/bundle.esm.js:84350); leaving it stale would make any future
    // reader of `scene.sceneName` disagree with the map it is keyed in.
    target.sceneName = nextName
    nameOfScene.set(target, nextName)
  }

  /**
   * Moves the current scene's camera along its existing view direction to
   * the distance that frames the object, and renders.
   *
   * No-op on a scene the reader has posed: see `posedScenes`.
   */
  function refitCurrentScene(aspect: number) {
    const target = scene.value
    const renderer = stage.renderer.value
    const name = target ? nameOfScene.get(target) : undefined
    if (!target || !renderer || !name || posedScenes.has(name)) return

    const bounds = boundsByScene.get(name)
    const preset = viewpointByScene.get(name)
    if (!bounds || !preset) return

    if (fitView(target, preset, aspect, bounds)) renderer.render()
  }

  /** Called by `CopperStage` on the first real user gesture, and undone by
   *  `Reset view`. */
  function markPosed(posed: boolean) {
    const target = scene.value
    const name = target ? nameOfScene.get(target) : undefined
    if (!name) return
    if (posed) posedScenes.add(name)
    else posedScenes.delete(name)
  }

  async function load(slug: string, modality: Modality) {
    const renderer = stage.renderer.value
    const Copper = stage.Copper.value
    if (disposed || !stage.ready.value || !renderer || !Copper) return

    const name = sceneName(slug, modality)
    const token = ++loadToken
    loadError.value = undefined

    // Already built: switch to it rather than re-downloading a 10-50MB
    // volume. What the cache does not free while a scene is resident is
    // decoded volume memory: the worst pair in the catalogue
    // (cancer-lobular's mammogram + MRI) is ~75MB of NRRD on disk, and NRRD
    // volumes decode to raw typed arrays larger still than that compressed
    // size. The bandwidth this saves on the modality stepper's
    // back-and-forth navigation outweighs that, but it is a real tradeoff,
    // not a free one -- which is why `budget` (sceneBudget.ts) caps it.
    //
    // Before fix round 1 residency was bounded structurally: every case had
    // its own page key, so leaving it unmounted CopperStage and
    // `useCopperStage`'s dispose() tore the whole renderer down, GPU
    // context included. Every case now shares one page instance
    // (app/utils/pageKey.ts), so that structural bound is gone entirely and
    // the byte budget replaces it.
    const existing = renderer.getSceneByName(name)
    if (existing) {
      activateScene(renderer, existing)
      sliceState.value = sliceStateByScene.get(name) ?? null
      viewpoint.value = viewpointByScene.get(name)
      loading.value = false
      progress.value = 1
      touchScene(renderer, existing, name)
      refitCurrentScene(stage.aspect())
      renderer.render()
      return
    }

    loading.value = true
    progress.value = 0

    // Hoisted above the try block so the catch below can tell "createScene
    // itself refused" (nothing to undo) apart from "a scene was created
    // but its content failed to load" (review round 2, fix #1 -- that
    // scene is now registered in copper3d's own sceneMap and must be
    // evicted, or a later visit finds it and treats it as a silently
    // broken success).
    let next: CopperScene | undefined

    try {
      // `controls: 'copper3d'` is `Copper3dTrackballControls`, which is what
      // the legacy app used on every viewer it had (`controls: "copper3d"`,
      // frontend/plugins/copper.js:20). Until copper3d 3.9.0 this class
      // hardcoded OrbitControls and the app had to swap the instance out
      // after construction; the option also turns on `updateOnInput`, without
      // which an on-demand viewer is dead to the mouse (see useCopperStage).
      next = renderer.createScene(name, { controls: 'copper3d' })
      if (!next) throw new Error(`copper3d refused to create scene "${name}"`)
      // Review fix #1 (second half): remove the leaked resize listener
      // immediately at creation, not deferred to this scope's disposal.
      // useCopperStage's own ResizeObserver already calls
      // `getCurrentScene().onWindowResize()` on every container resize (a
      // strict superset of window-resize-triggered changes -- it also
      // catches panel-collapse layout changes with no window resize event
      // at all), so `confirmResize`'s window-resize wiring is entirely
      // redundant here. Removing it up front makes the leak fix
      // unconditional instead of depending on this scope ever disposing --
      // 3.9.0's `scene.dispose()` covers the eviction path, not this one.
      window.removeEventListener('resize', next.confirmResize, false)

      activateScene(renderer, next)
      // No inertia -- the human's requirement #2: the model stops the instant
      // the pointer does. The legacy app left this off (its `staticMoving`
      // lines are commented out, Model.vue:235), i.e. it drifted on release.
      next.controls.staticMoving = true
      /**
       * A TRACKBALL number, not an OrbitControls one -- the same value there
       * is 3x that class's default, which is what made rotation feel
       * uncontrollable when this ran against OrbitControls.
       *
       * Halved from the legacy app's 3.0 (LeftModel.vue:156, Model.vue:236)
       * because copper3d 3.9.0's `updateOnInput` changed what the number
       * means. `rotateCamera` turns by `_moveCurr - _movePrev` and then sets
       * `_movePrev = _moveCurr`, while `onMouseMove` shifts both along on
       * every event -- so with one `update()` per FRAME only the last event's
       * delta survived and everything between frames was discarded. Updating
       * per event integrates the whole gesture instead, which is both correct
       * and, for the same hand movement, several times more rotation.
       *
       * Side effect worth knowing: the old feel depended on mouse polling
       * rate (a 1000Hz mouse threw away more motion, so it rotated SLOWER).
       * This one does not, so the value is stable across devices.
       */
      next.controls.rotateSpeed = 1.5
      // The anatomy viewer pans slower than the imaging viewers, which orbit
      // a much larger NRRD volume.
      next.controls.panSpeed = modality.id === 'anatomy' ? 0.2 : 0.5

      const slice = modality.id === 'anatomy'
        ? await loadAnatomy(next, url(modality.asset), name)
        : await loadImaging(next, Copper, modality, url(modality.asset), token, name)

      if (disposed) return // torn down mid-load; nothing left to update

      // This load succeeded (a failed one is handled in the catch below,
      // via eviction instead). Content was already added into `next`
      // synchronously inside the load callback above, so finish its
      // bookkeeping unconditionally, even if a newer load has since
      // superseded this one (review fix #3) -- otherwise a later switch
      // back to this modality finds it cached but half-built: no slice
      // state, no camera preset, `getSceneByName` short-circuiting on it
      // forever.
      sliceStateByScene.set(name, slice)
      nameOfScene.set(next, name)
      // Unconditional for the same reason, and just as load-bearing
      // (finding 1): this scene now holds real content and must count
      // against the budget even though a superseded load never reaches
      // `touchScene` below to register it there itself. Without this, a
      // scene a superseded load finished building sat in copper3d's
      // `sceneMap` forever, invisible to the budget's overflow check.
      budget().register(name, sceneBytes(slice))
      // Named `preset`, not `viewpoint`, to avoid shadowing the outer
      // `viewpoint` ref this composable exposes.
      const preset = await fetchViewPoint(url(modality.viewPreset))
      if (disposed) return
      next.loadView(preset)
      viewpointByScene.set(name, preset)
      // Frames whatever scene is genuinely on screen right now, not
      // necessarily `next`: if a later load has already superseded this one,
      // `scene.value` already points at ITS scene (its own `activateScene`
      // ran before this `await`), and `refitCurrentScene` reads bounds/preset
      // back off `scene.value`'s own name -- so this is correct either way,
      // not just for the common case.
      refitCurrentScene(stage.aspect())

      if (token !== loadToken) return // superseded by a later load() call

      sliceState.value = slice
      viewpoint.value = preset
      next.onWindowResize()
      loading.value = false
      progress.value = 1
      // Applied only once the scene genuinely holds content, and only for
      // the load still on screen -- a failed load is evicted by the catch
      // below instead, and a superseded one must not push the scene the
      // user is actually looking at further down the LRU.
      touchScene(renderer, next, name)
      renderer.render()
    }
    catch (err) {
      if (disposed) return
      // Review round 2, fix #1: `next` is only set once `createScene`
      // actually built (and registered) a scene for `name` this attempt --
      // evicting here undoes exactly that registration, never an
      // unrelated scene already cached from an earlier, successful load.
      // Unconditional on `token`: even a superseded load's own poisoned
      // entry must not survive under its own name, or a later visit to
      // that modality finds it via getSceneByName regardless of which
      // load happened to be "current" when it failed.
      // Shared with fix round 1's residency cap, so there is exactly one
      // way out of copper3d's scene map and exactly one place that checks
      // the eviction actually took.
      if (next) removeSceneFromMap(renderer,name)
      if (token !== loadToken) return
      loadError.value = err instanceof Error ? err : new Error(String(err))
      loading.value = false
    }
  }

  /**
   * Downloads a GLB into `target` and gives it this app's appearance.
   *
   * `loadGltf` recentres the group on the origin (every preset in
   * `public/modelView/**` targets `[0,0,0]`, so a model left at its authored
   * offset would be framed off-screen), bounds the dolly with
   * `controls.maxDistance`, and adds it to the scene. Its own "frame the new
   * model" camera write only runs while `cameraPositionFlag` is unset, and
   * `load()` applies the modality's view preset immediately afterwards
   * regardless -- and by the time §7.1's morph calls this, `loadView` has
   * already set the flag, which is what keeps a crossfade from moving the
   * camera.
   *
   * The `onError` is copper3d 3.9.0; before it there was no error channel at
   * all and this app ran its own `GLTFLoader`. The wall-clock timeout stays
   * as the net for a connection that neither completes nor errors.
   *
   * Shared by the initial load and by the morph so the incoming morph model
   * goes through the SAME `tintFatLayer` (controller correction C2) --
   * otherwise every crossfade would end on a model that looks different from
   * the one it replaced, a visible pop at t=1.
   */
  async function loadGlb(target: CopperScene, assetUrl: string): Promise<SceneObject> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const group = await new Promise<SceneObject>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out loading anatomy model: ${assetUrl}`)),
        GLB_LOAD_TIMEOUT_MS,
      )
      target.loadGltf(assetUrl, resolve, {
        onError: err => reject(
          err instanceof Error ? err : new Error(`Failed to load ${assetUrl}: ${String(err)}`),
        ),
      })
    }).finally(() => clearTimeout(timer))

    // Awaited: it swaps the fat layer's material, and returning before that
    // lands would let the morph's `collectFadeTargets` capture the GLB's
    // original material and then fade a material no longer on the mesh.
    await tintFatLayer(group)
    return group
  }

  async function loadAnatomy(target: CopperScene, assetUrl: string, name: string): Promise<null> {
    const group = await loadGlb(target, assetUrl)
    group.name = 'anatomy-model'
    anatomyAssetByScene.set(target, assetUrl)
    const { Box3, Vector3 } = await import('three')
    try {
      // `Box3.setFromObject` walks real `Object3D` machinery
      // (`updateWorldMatrix`, `matrixWorld`, ...) that only a genuine
      // GLTFLoader group has -- which is all `loadGlb` ever hands this in
      // production. Guarded anyway: a measurement failing must degrade to
      // "no auto-fit for this scene" (the model still displays, at the
      // preset's own unmodified distance), not fail a load that has already
      // successfully added its content to the scene.
      const box = new Box3().setFromObject(group as never)
      const size = box.getSize(new Vector3())
      // The centre matters as much as the size here: a GLB's box is not
      // centred on the origin the presets target, so framing from the
      // origin leaves part of the model outside the frame -- visible as
      // soon as a panel narrows. See `refitCurrentScene`.
      const centre = box.getCenter(new Vector3())
      boundsByScene.set(name, {
        width: size.x,
        height: size.y,
        depth: size.z,
        center: [centre.x, centre.y, centre.z],
      })
    }
    catch {
      boundsByScene.delete(name)
    }
    return null
  }

  /**
   * §7.1 density morph. Loads `modality`'s GLB into the CURRENT scene
   * alongside the one already there and returns the crossfade, ready to be
   * driven. Returns null when there is nothing to morph -- no scene, not an
   * anatomy modality, no model on screen yet, or (controller correction
   * C12) the incoming asset is the one already displayed.
   *
   * Deliberately does NOT touch `loading`: the outgoing model stays on
   * screen for the whole download, so there is no blank stage to explain,
   * and raising the loading overlay would flash a spinner over the very
   * transition it is meant to be seamless. The camera is untouched too --
   * `loadView` has already run for this scene, which sets copper3d's
   * `cameraPositionFlag` (dist/bundle.esm.js:84054), and that flag is what
   * suppresses `loadGltf`'s own "frame the new model" camera write
   * (dist/bundle.esm.js:84305). Without a previous `loadView` this method
   * would silently move the camera, which is exactly what §7.1 forbids.
   */
  async function prepareMorph(slug: string, modality: Modality): Promise<AnatomyMorph | null> {
    const renderer = stage.renderer.value
    const target = scene.value
    if (disposed || !renderer || !target || modality.id !== 'anatomy') return null

    // Fix round 1: a second morph on a scene whose incoming model is still
    // downloading would claim the same outgoing model as its own -- both
    // would rename it, and whichever committed second would remove a group
    // the other was still fading. Reachable by stepping density-b then
    // density-c before the first ~1.28MB GLB lands. Falling through to an
    // ordinary load is the right answer for the second navigation anyway:
    // it is the one the user is waiting on.
    if (morphingScenes.has(target)) return null

    const previous = target.scene.getObjectByName('anatomy-model')
    if (!previous) return null

    const assetUrl = url(modality.asset)
    if (anatomyAssetByScene.get(target) === assetUrl) return null

    morphingScenes.add(target)
    let incoming: SceneObject
    try {
      incoming = await loadGlb(target, assetUrl)
    }
    finally {
      morphingScenes.delete(target)
    }
    // Fix round 1: nothing above this line may mutate the scene. An earlier
    // version renamed `previous` BEFORE this await, so a GLB that never
    // arrived (the 30s timeout -- copper3d has no error callback to fail
    // faster on) left the scene with nothing named `anatomy-model` at all,
    // and every later morph from that scene returned null: §7.1 silently
    // and permanently degraded to a hard cut for the rest of the session.
    if (disposed) return null

    // Renamed as the incoming model takes the name, so `getObjectByName`
    // can never return the outgoing model to a morph that starts while this
    // one is still fading. Both objects are in the scene at once for the
    // whole crossfade; only one of them may answer to 'anatomy-model'.
    previous.name = 'anatomy-model-outgoing'
    incoming.name = 'anatomy-model'

    const outgoingFade = collectFadeTargets(previous)
    const incomingFade = collectFadeTargets(incoming)
    setFade(incomingFade, 0)

    let committed = false
    return {
      apply(t: number) {
        const clamped = Math.min(1, Math.max(0, t))
        setFade(incomingFade, clamped)
        setFade(outgoingFade, 1 - clamped)
      },
      commit() {
        if (committed) return
        committed = true
        restoreFade(incomingFade)
        target.scene.remove(previous)
        disposeObject3D(previous)
        anatomyAssetByScene.set(target, assetUrl)
        // The scene now holds the incoming case's model, so it has to
        // answer to the incoming case's name -- see `adoptSceneName`.
        adoptSceneName(renderer, target, sceneName(slug, modality))
      },
    }
  }

  function loadImaging(
    target: CopperScene,
    Copper: CopperModule,
    modality: Modality,
    assetUrl: string,
    token: number,
    name: string,
  ): Promise<SliceState | null> {
    return new Promise((resolve, reject) => {
      const bar = Copper.loading()
      // Ultrasound is the app's one 2D modality (design doc §3.1's md5
      // audit: the u2d.nrrd asset only exists for benign-cyst) -- a single
      // flat slice has nothing to orbit.
      const flat = modality.id === 'ultrasound'

      let stallTimer: ReturnType<typeof setTimeout>
      function armStallTimer() {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => {
          settle()
          reject(new Error(
            `Stalled loading ${modality.id} volume (no progress for ${NRRD_STALL_TIMEOUT_MS}ms): ${assetUrl}`,
          ))
        }, NRRD_STALL_TIMEOUT_MS)
      }
      function settle() {
        clearTimeout(stallTimer)
      }
      /**
       * Re-arms the stall timer unconditionally (even for a superseded load
       * -- it still needs to eventually settle so review fix #1's eviction
       * can run), but only writes the shared `progress` ref while this is
       * still the current load (review round 2, fix #2): without that guard,
       * a superseded load's late progress events kept landing in a ref a
       * newer, on-screen load already owns, jittering design doc §13.1's
       * progress ring between two unrelated downloads.
       */
      function onProgress(event: ProgressEvent) {
        if (token === loadToken) {
          // `total` is 0 unless the server sent a Content-Length, and it does
          // not send one for a gzipped or chunked response. Bytes are still
          // arriving, there is just no fraction to express -- NaN signals
          // "indeterminate" to whatever renders this, rather than silently
          // freezing at whatever `progress` last held (review round 2, fix #3).
          progress.value = event.total > 0 ? event.loaded / event.total : Number.NaN
        }
        armStallTimer()
      }
      armStallTimer() // starts the clock even before the first progress event

      try {
        target.loadNrrd(
          assetUrl,
          bar,
          true,
          (volume, meshes, slices) => {
            settle()
            target.addObject(meshes.z)
            meshes.z.name = 'z'

            // MRI only: that is the modality the client reported too dark,
            // and the mammograms' dynamic range is already even.
            const exposure = modality.id === 'mri' ? exposureExponent(volume) : 1

            // copper3d's `loadNrrd` builds the slice objects and their
            // canvas-backed textures but never PAINTS them, so the plane
            // renders as solid black until something moves the slice.
            // Measured in a real browser on
            // `/case/density-d/mammogram`: the texture canvas held 0
            // non-transparent pixels out of 1,161,405 after a fully
            // successful load, and 359,777 non-black ones immediately
            // after this call. The stage was black on every imaging
            // modality, on every case.
            //
            // `load()` already calls `renderer.render()` once the preset
            // has been applied, so no extra render is needed here -- the
            // frame it draws simply had nothing in the texture to show.
            // Called via `.call` because copper3d's own scrubbing does the
            // same (`frontend/plugins/copper.js:110`): `repaint` is taken
            // off the slice object and needs its `this` bound back.
            //
            // AWAITED, not fire-and-forget. The exposure LUT lives in the
            // patched repaint, so painting before the patch lands would draw
            // one dark frame and correct it on the reader's first scrub --
            // exactly the colour change the client asked not to see. This
            // promise gates `resolve` below, and `load()` draws its only
            // frame after that. A failed patch still paints, just with
            // copper3d's own repaint and no lift.
            const painted = installFastSliceRepaint(slices.z, exposure)
              .catch(() => {})
              .then(() => {
                slices.z.repaint.call(slices.z)
              })

            const [rx, ry, rz] = volume.RASDimensions
            // `RASDimensions` describes a box centred on the origin, which
            // is exactly what every `*_view.json` preset targets -- so the
            // centre offset is zero here and the imaging framing is
            // unaffected by the GLB centring fix.
            boundsByScene.set(name, {
              width: rx ?? 0,
              height: ry ?? 0,
              depth: rz ?? 0,
              center: [0, 0, 0],
            })

            if (flat) {
              // The legacy 2D views locked both (Model.vue:268-269). Written
              // through copper3d's normalisers rather than as `noRotate` /
              // `enableRotate` directly: those are opposite spellings
              // belonging to different controls classes, and writing the
              // wrong one lands as an unread field -- which is exactly how
              // every flat view stayed rotatable for so long.
              setRotateEnabled(target.controls, false)
              setPanEnabled(target.controls, false)
              painted.then(() => resolve(null), reject)
            }
            else {
              // 3D modalities only, exactly like the legacy app: the flat
              // branch above returns before this, and Model.vue:267-283 put
              // the box in the same `else`. The colour is this app's border
              // tone -- copper3d defaults to white, which reads against a
              // dark viewer and vanishes on this stage's light background.
              const z = slices.z
              addVolumeBoundingBox(target, volume.RASDimensions, { color: 0x8A7F84 })
              painted.then(
                () => resolve({ max: z.MaxIndex, raw: z, mesh: meshes.z }),
                reject,
              )
            }
          },
          {
            openGui: false,
            // Only the z plane is ever displayed: the stage shows a single
            // axial slice and `useSliceControl` raycasts only against it.
            // `extractSlice` walks the whole volume per axis and the result
            // is retained on `volume.sliceList` for the volume's lifetime,
            // so x and y used to cost two full passes over a 10-50MB buffer
            // plus two slice planes this app disposed immediately.
            axes: ['z'],
            onProgress,
            onError: (err) => {
              settle()
              reject(err instanceof Error ? err : new Error(String(err)))
            },
          },
        )
      }
      catch (err) {
        settle()
        reject(err)
      }
    })
  }

  /** `loadViewUrl` is a raw XHR with no completion signal at all (see
   * CopperScene.loadView's doc) -- fetching the same JSON directly is the
   * only way to know when the preset has actually landed, so a render can
   * be requested after. A missing/malformed preset propagates to
   * `load()`'s own catch (surfaced as the modality's load failure) rather
   * than silently leaving the default camera in place -- content/cases.ts
   * pairs every modality with a real viewPreset path, so a 404 here means
   * the asset catalogue itself is wrong and should say so, not hide it. */
  async function fetchViewPoint(viewPresetUrl: string): Promise<CopperViewPoint> {
    const response = await fetch(viewPresetUrl)
    if (!response.ok) throw new Error(`Failed to fetch view preset (${response.status}): ${viewPresetUrl}`)
    return response.json() as Promise<CopperViewPoint>
  }

  onScopeDispose(() => {
    disposed = true
    if (pinnedName) budget().unpin(pinnedName)
  })

  return { scene, loading, progress, sliceState, loadError, viewpoint, load, prepareMorph, refitCurrentScene, markPosed }
}

/**
 * Matches the legacy app's only GLB material treatment
 * (frontend/components/model/LeftModel.vue:160-174): the fat-layer mesh
 * becomes a translucent amber (`#a3932a`, 40% opacity) so the
 * fibroglandular tissue underneath reads through it -- the whole point of
 * showing an anatomy model per density case. copper3d's `loadPureGLB` (the
 * only method with a `color` option, and not even the one this renderer's
 * scene class exposes -- see copper-types.ts's `loadGltf` doc) never
 * actually reads that option: dist/bundle.esm.js:83678-83706 applies
 * `enhanceMaterial`'s generic PBR tweaks but never touches `opts.color`.
 * There is no library feature to lean on here, so this reproduces the
 * legacy component's traversal by hand instead of inventing a new
 * appearance (a flat pink tint, as an earlier draft of this task assumed,
 * would not have matched the original app at all).
 *
 * REPLACES the material, as the legacy app does. An earlier version instead
 * mutated the GLB's own material in place -- setting `transparent`,
 * `opacity` and `color` on it -- to avoid importing `three` here. That is
 * not the same thing, and it is what the human meant by the colour being
 * off, and drab:
 *
 *   - `material.color` MULTIPLIES `material.map` in three. The GLB's fat
 *     mesh carries a flesh-toned baseColor texture, so tinting it olive
 *     produced flesh x olive = a muddy khaki. The legacy material has no
 *     `map` at all, so `#a3932a` is the literal colour of a clean 40%
 *     translucent film, and the flesh tones the human remembers come from
 *     the tissue READ THROUGH it.
 *   - The original also keeps its normal/roughness/metalness maps, which
 *     the legacy material does not have (a fresh MeshPhysicalMaterial is
 *     roughness 1, metalness 0, no maps).
 *
 * Importing `three` here means a second copy of it crosses into a copper3d
 * scene. That is safe because the versions are identical: `three@0.185.1` is
 * pinned in package.json and is the same build copper3d inlines (yarn
 * resolves this app's three from copper3d's own dependency), and three's
 * scene graph dispatches on `.isMesh`/`.isMaterial` marker properties rather
 * than `instanceof` precisely so mixed copies interoperate. If copper3d ever
 * bundles a different revision, that pin must move with it.
 */
async function tintFatLayer(group: SceneObject): Promise<void> {
  const targets: NonNullable<SceneObjectChild['material']>[] = []
  const meshes: SceneObjectChild[] = []
  group.traverse((child) => {
    if (!child.isMesh || child.name !== 'VH_F_fat_L' || !child.material) return
    meshes.push(child)
    targets.push(child.material)
  })
  if (!meshes.length) return

  const { MeshPhysicalMaterial } = await import('three')
  for (const mesh of meshes) {
    mesh.material = new MeshPhysicalMaterial({
      transparent: true,
      opacity: 0.4,
      color: FAT_LAYER_COLOR,
      /**
       * LOAD-BEARING. A transparent surface that still writes depth occludes
       * whatever is drawn behind it, and three draws the opaque lobes BEFORE
       * the transparent shell -- so the shell's depth writes decided, per
       * pixel and per draw order, which lobes composited correctly and which
       * did not. The visible result was that some lobes read pink and others
       * read a muddy yellow, with nothing in the geometry to explain it:
       * removing the fat shell shows every lobe is the same pink `#bb6666`.
       *
       * `setFade` below already suppresses `depthWrite` for the crossfade and
       * says why. The same reason applies to the shell's resting state, which
       * is transparent all the time.
       */
      depthWrite: false,
    }) as unknown as SceneObjectChild['material']
  }
  // The GLB's own material (and its textures) are now unreferenced. copper3d
  // never disposes materials it did not create, and the density morph swaps
  // models repeatedly, so dropping these here is the difference between a
  // bounded and an unbounded texture footprint.
  for (const material of targets) {
    material.map?.dispose?.()
    material.dispose()
  }
}
