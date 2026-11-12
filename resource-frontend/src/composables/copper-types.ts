import type { Ref } from 'vue'

/**
 * These interfaces describe only what is actually reachable through
 * `copperRendererOnDemond` in copper3d@3.7.3 -- verified by reading the
 * shipped `.d.ts` files AND the compiled `dist/bundle.esm.js` (the two
 * disagree with each other in a couple of places, see the comments below).
 * copper3d ships broader types built around its *other* renderer/scene
 * pair (`copperRenderer` / `copperScene`), which is not what this app uses
 * (design doc §8.2: one on-demand renderer). Extend this file, don't widen
 * it back toward those broader unions or fall back to `any` (global
 * constraint).
 */

/** The parts of three's Vector3 we use. */
export interface Vec3 {
  x: number
  y: number
  z: number
  set: (x: number, y: number, z: number) => void
  copy: (v: Vec3) => Vec3
  clone: () => Vec3
  length: () => number
  normalize: () => Vec3
  lerp: (v: Vec3, alpha: number) => Vec3
  applyAxisAngle: (axis: Vec3, angle: number) => Vec3
  sub: (v: Vec3) => Vec3
  add: (v: Vec3) => Vec3
  multiplyScalar: (s: number) => Vec3
}

export interface CopperCamera {
  position: Vec3
  up: Vec3
  lookAt: ((x: number, y: number, z: number) => void) & ((target: Vec3) => void)
  updateProjectionMatrix: () => void
  /**
   * Vertical field of view in degrees. Not used by copper3d's own view
   * presets -- `fitView` reads it to work out how far back the camera
   * has to sit for the object to fill the frame. Present because the
   * underlying object is a three `PerspectiveCamera`; declared here
   * because this type is the app's whole view of it.
   */
  fov: number
}

/**
 * `Copper3dTrackballControls` -- copper3d's own TrackballControls variant,
 * which is what the legacy app used everywhere (`controls: "copper3d"`,
 * frontend/plugins/copper.js:20) and what
 * `createScene(name, { controls: 'copper3d' })` builds.
 *
 * Shaped accordingly: `noRotate`/`noPan`, not `enableRotate`/`enablePan`.
 * They are opposite spellings belonging to different controls classes and
 * writing the wrong pair lands as an unread field, which is how every flat
 * view stayed rotatable for so long -- prefer copper3d's `setRotateEnabled` /
 * `setPanEnabled`, which pick the right one.
 */
export interface CopperControls {
  rotateSpeed: number
  panSpeed: number
  /** TrackballControls' rotate/pan locks. The legacy app's 2D views used
   * exactly these (frontend/components/model/Model.vue:268-269), and so does
   * its slice-scrub raycaster (frontend/plugins/copper.js:80,86). */
  noRotate: boolean
  noPan: boolean
  /**
   * `true` = no inertia: the camera stops the instant the pointer does.
   * The legacy app left this at `false` (its `staticMoving = true` lines are
   * commented out, Model.vue:235 and PanelControls.vue:123), i.e. it drifted
   * on release. Turned ON here at the human's explicit request: the model
   * should stop exactly where it was rotated to, and stay there. This is a
   * deliberate divergence from legacy feel,
   * not an oversight.
   */
  staticMoving: boolean
  /**
   * copper3d 3.9.0. Makes the input handlers drive the camera themselves
   * rather than only recording positions for the next `update()`. Required
   * for on-demand rendering, and set for you by
   * `createScene(name, { controls: 'copper3d' })`.
   */
  updateOnInput: boolean
  /**
   * TrackballControls caches the canvas's page-relative box in `screen` and
   * only recomputes it here -- unlike OrbitControls, which measures per
   * event. Without a call after every container resize, rotation is computed
   * against stale bounds and the model appears to swing off-axis.
   */
  handleResize: () => void
  minDistance?: number
  maxDistance?: number
  target?: Vec3
  /**
   * Review fix #1: `copperSceneOnDemond`'s constructor does
   * `new OrbitControls(this.camera, renderer.domElement)` against the
   * *shared* canvas (Scene/copperSceneOnDemond.js:28) and wires
   * `controls.addEventListener("change", requestRenderIfNotRequested)`,
   * which renders that specific scene. `setCurrentScene`
   * (Renderer/copperRendererOnDemond.js:16-24) never disables the
   * controls of whatever scene it's switching away from, so with more
   * than one cached scene, a single mouse drag reaches every one of
   * their controls and the last-created scene paints last, regardless of
   * which is actually on screen. `enabled` is the real off switch on
   * `Copper3dTrackballControls` too (its own field, bundle.esm.js:66306;
   * every pointer handler returns early on `scope.enabled === false`), so
   * setting it `false` genuinely stops that scene's controls from ever
   * dispatching `change`. useModalityScene sets this `false` on the
   * outgoing scene and `true` on the incoming one at every switch.
   */
  enabled: boolean
  /** The scene's constructor registers its own `requestRenderIfNotRequested`
   * here; that listener is what keeps on-demand rendering alive. */
  addEventListener?: (type: 'change', listener: () => void) => void
  /** Detaches the pointer/wheel listeners the constructor put on the shared
   * canvas. NOT called on eviction: it ends in
   * `domElement.style.touchAction = ''`, and every scene shares one canvas. */
  dispose?: () => void
  /**
   * From three's `EventDispatcher`, which `Controls` extends. The one
   * listener that matters here is the `change` handler
   * `copperSceneOnDemond`'s constructor registers
   * (`controls.addEventListener("change", this.requestRenderIfNotRequested)`,
   * dist/bundle.esm.js:84291) -- it is the reference chain that keeps an
   * evicted scene, and its decoded volume, reachable from the shared
   * canvas's own DOM listeners. Optional on this type only because a
   * copper3d upgrade could plausibly drop `EventDispatcher`; see
   * useModalityScene's `evictScene` for why `controls.dispose()` is NOT
   * used instead.
   */
  removeEventListener?: (type: 'change', listener: () => void) => void
}

/** copper3d's nrrd slice object. `index` is a world coordinate; divide by
 * `volume.spacing[2]` to get the slice number. copper3d's own types give
 * up and type this `any` (types/types.ts's `nrrdSliceType`), which is
 * exactly why this narrower interface exists instead of using theirs. */
export interface NrrdSlice {
  index: number
  MaxIndex: number
  volume: { spacing: number[] }
  repaint: (this: NrrdSlice) => void
}

/**
 * One of copper3d's three nrrd slice planes. Only the fields below are read
 * or written here; the object is otherwise opaque and is handed straight back
 * to copper3d (`addObject`, `pickSpecifiedModel`), so this deliberately does
 * not model three's `Mesh` in full -- see this file's header on why no
 * `three` type may cross this boundary. `geometry`/`material` are duck-typed
 * the exact same way `SceneObjectChild`'s already are below, not imported.
 */
export interface NrrdMesh {
  name: string
  /** three's `Object3D.traverse`, which is how `disposeObject3D` frees the
   *  x/y planes this app never displays. */
  traverse: (fn: (child: SceneObjectChild) => void) => void
  isMesh?: boolean
  geometry?: { dispose: () => void }
  /** `Material.dispose()` does not cascade into `map`: a slice plane's
   * material wraps a canvas-backed `Texture` (its `map`) that needs its own
   * dispose call, or the decoded pixel data it references stays uploaded to
   * the GPU. */
  material?: { dispose: () => void, map?: { dispose: () => void } }
}

export interface NrrdMeshes {
  x: NrrdMesh
  y: NrrdMesh
  z: NrrdMesh
}

export interface NrrdVolume {
  RASDimensions: number[]
  windowHigh: number
  /**
   * three's `Volume.computeMinMax()` result, cached on the instance. The
   * display window is set to exactly these (bundle.esm.js:61725), which is
   * why the tissue comes out dark -- see `ts/Utils/volumeExposure.ts`.
   */
  min: number
  max: number
  /** The decoded voxels. Read-only here: `exposureExponent` measures their
   *  distribution and never writes one. */
  data: ArrayLike<number>
  repaintAllSlices: () => void
}

export interface LoadingBar {
  loadingContainer: HTMLDivElement
  progress: HTMLDivElement
}

/**
 * The shape `loadView` expects and every `*_view.json` asset actually has on
 * disk (checked `public/modelView/left_breast_view.json` and
 * `density-1/middle/m_view.json` directly). Matches the destructuring in
 * `baseScene.loadView` (Scene/baseScene.js:88-98).
 */
export interface CopperViewPoint {
  farPlane: number
  nearPlane: number
  eyePosition: number[]
  targetPosition: number[]
  upVector: number[]
}

/** A visible object in the scene (GLB group or nrrd mesh). */
export interface SceneObject {
  name: string
  traverse: (fn: (child: SceneObjectChild) => void) => void
}

export interface SceneObjectChild {
  isMesh?: boolean
  /** three's Object3D always has this (default `""`), never undefined --
   * used to find the anatomy GLB's fat-layer mesh by name (see
   * useModalityScene's `tintFatLayer`, matching
   * frontend/components/model/LeftModel.vue:162's `child.name ==
   * "VH_F_fat_L"` check, the legacy app's only GLB material treatment). */
  name: string
  geometry?: { dispose: () => void }
  material?: {
    dispose: () => void
    transparent: boolean
    opacity: number
    depthWrite: boolean
    /** Present on the PBR materials glTF's default material maps to
     * (MeshStandardMaterial/MeshPhysicalMaterial); modelled narrowly as the
     * one mutator useModalityScene needs, not the full three.js `Color`
     * class. Deliberately not importing `three` for this type: see this
     * file's header comment on why only one hoisted copy may exist. */
    color?: { set: (value: string) => void }
    /** The baseColor texture a glTF material carries. Needs its own dispose
     * when the material is replaced -- `Material.dispose()` does not cascade
     * into it. See `tintFatLayer`. */
    map?: { dispose?: () => void }
  }
}

/**
 * What's actually guaranteed on whatever `CopperRenderer.getCurrentScene()`
 * returns. Before `setCurrentScene()` is ever called, that's the
 * renderer's own placeholder `baseScene` (Renderer/baseRenderer.d.ts's
 * constructor builds one directly), not a `copperSceneOnDemond` --
 * `baseScene` has no `loadGltf`/`loadNrrd` and no OrbitControls-shaped
 * `controls` (those are `copperSceneOnDemond`/`copperScene`-only). Typing
 * `getCurrentScene()` as the full `CopperScene` let
 * `getCurrentScene().loadGltf(...)` compile and then throw at runtime on
 * exactly the placeholder-scene window this comment describes. Only
 * `onWindowResize` (Scene/baseScene.d.ts's own method, inherited by every
 * scene class) is guaranteed here.
 */
export interface CopperBaseScene {
  onWindowResize: () => void
}

export interface CopperScene extends CopperBaseScene {
  camera: CopperCamera
  /** Writable: `installTrackballControls` replaces copper3d's hardcoded
   * OrbitControls instance here. See `CopperControls`. */
  controls: CopperControls
  /**
   * The shared `WebGLRenderer` this scene draws with (`this.renderer`,
   * assigned in `copperSceneOnDemond`'s constructor, bundle.esm.js:84400).
   * Needed only for `domElement` -- the canvas the replacement controls must
   * attach their pointer listeners to, the same element copper3d passed to
   * its own `new OrbitControls(this.camera, renderer.domElement)`.
   */
  renderer: { domElement: HTMLCanvasElement }
  /**
   * copper3d's own record of the key this scene is registered under in
   * `CopperRenderer.sceneMap` (`baseScene`'s field, written by
   * `createScene`, dist/bundle.esm.js:84350). §7.1's morph swaps a scene's
   * contents without rebuilding it, so useModalityScene re-keys the scene
   * and keeps this in step -- a scene whose own `sceneName` disagreed with
   * the map it lives in is exactly the kind of quiet inconsistency the
   * morph already had to fix once for its asset.
   */
  sceneName: string
  /**
   * `copperSceneOnDemond`'s per-frame render request
   * (Scene/copperSceneOnDemond.d.ts:12), declared as a property rather than
   * a method, so reading it back gives the exact function reference its
   * constructor registered on `controls`' `change` event. That makes it
   * removable -- the same trick `confirmResize` below relies on.
   */
  requestRenderIfNotRequested: () => void
  scene: {
    add: (obj: SceneObject) => void
    remove: (obj: SceneObject) => void
    getObjectByName: (name: string) => SceneObject | undefined
    /**
     * three's `Object3D.children` -- the live array, not a snapshot.
     * `evictScene` sweeps this directly (finding 2) rather than a hardcoded
     * list of names, so it cannot silently miss whatever a future loader
     * adds to the scene under a name nobody thought to list.
     */
    children: SceneObject[]
  }
  addObject: (obj: unknown) => void
  loadNrrd: (
    url: string,
    loadingBar: LoadingBar,
    segmentation: boolean,
    callback: (volume: NrrdVolume, meshes: NrrdMeshes, slices: { z: NrrdSlice }) => void,
    opts?: {
      openGui?: boolean
      /**
       * copper3d 3.9.0. Which slice planes to extract; defaults to all
       * three. `extractSlice` walks the whole volume per axis and the result
       * is retained on `volume.sliceList` for the volume's lifetime, so an
       * axis nothing displays is a full pass over a 10-50MB buffer plus a
       * slice plane that is never freed.
       *
       * The omitted axes come back `undefined` on `meshes`/`slices` --
       * copper3d's own types still declare all three, so a caller that
       * narrows this is responsible for reading only what it asked for.
       * `NrrdMeshes` below is narrowed to `z` for exactly that reason.
       */
      axes?: readonly ('x' | 'y' | 'z')[]
      /** copper3d 3.9.0. Fires in addition to the built-in loading bar.
       *  `total` is 0 when the server sent no Content-Length. */
      onProgress?: (event: ProgressEvent) => void
      /** copper3d 3.9.0. Before it there was no error channel at all, and a
       *  failed volume was indistinguishable from a slow one. */
      onError?: (error: unknown) => void
    },
  ) => void
  /**
   * Recentres the group on the origin (every preset in `public/modelView/**`
   * targets `[0,0,0]`), bounds the dolly with `controls.maxDistance`, and
   * adds it to the scene. Its own "frame the new model" camera write only
   * runs while copper3d's `cameraPositionFlag` is unset -- `load()` applies
   * the view preset immediately afterwards anyway, and by the time §7.1's
   * morph runs `loadView` has already set the flag.
   *
   * `opts` is copper3d 3.9.0. Before it, the third argument three's
   * `GLTFLoader.load` treats as *onProgress* held an empty function named
   * `error`, and there was no fourth -- so a 404, a CORS refusal or a
   * malformed GLB invoked nothing at all and the load simply hung.
   */
  loadGltf: (
    url: string,
    callback?: (content: SceneObject) => void,
    opts?: {
      onProgress?: (event: ProgressEvent) => void
      onError?: (error: unknown) => void
    },
  ) => void
  /**
   * Not `loadViewUrl`. That method (Scene/baseScene.js:77-87) is a raw
   * `XMLHttpRequest` with no callback, event, or promise of any kind --
   * there is no way to know from outside when (or whether) it actually
   * lands. Under on-demand rendering, the `render()` call any caller makes
   * right after `loadViewUrl` necessarily draws before that XHR resolves,
   * so the preset camera framing it was supposed to produce never gets a
   * frame of its own once it does land -- design doc §5.3's camera preset
   * silently never appears until some unrelated interaction happens to
   * request one. `loadView` (Scene/baseScene.js:88-98, same JSON shape as
   * `CopperViewPoint` above) is the synchronous part `loadViewUrl` calls
   * internally after its XHR resolves; useModalityScene fetches the same
   * JSON itself and calls this directly so it has an awaitable completion
   * signal to render after. `loadViewUrl` itself is deliberately not in
   * this interface: nothing in this codebase calls it, and per this
   * project's standing rule against keeping unused surface "for whatever
   * else needs it," it was removed rather than kept on a vague promise --
   * re-add it (it does exist, and is harmless) if a real caller shows up.
   */
  loadView: (data: CopperViewPoint) => void
  /**
   * Inherited from `commonScene` (Scene/commonSceneMethod.d.ts), so it is
   * genuinely on `copperSceneOnDemond`'s prototype chain -- unlike
   * `resetView`/`loadPureGLB`. Raycasts `content` against the current camera
   * and returns the nearest hit, which is how the legacy app decided whether
   * a drag on the canvas was a slice scrub or a camera orbit
   * (frontend/plugins/copper.js:90).
   *
   * TWO things about the implementation matter to callers:
   *  · `mousePosition` is divided by `container.clientWidth/clientHeight`
   *    (dist/bundle.esm.js:65336-65341, `baseRaycaster`), so the coordinates
   *    must be relative to the renderer's CONTAINER. The legacy passed
   *    `event.offsetX/offsetY`, which are relative to whatever element the
   *    pointer is over -- the same thing only while the canvas exactly fills
   *    the container. useSliceControl measures off the container's own
   *    `getBoundingClientRect()` instead.
   *  · Passing a single mesh PUSHES it onto the scene's retained
   *    `pickableObjects` array; passing an ARRAY replaces that array
   *    (dist/bundle.esm.js:68832-68839). Per-pointer-event calls must
   *    therefore always pass an array, or the pickable list grows without
   *    bound for the life of the scene.
   */
  pickSpecifiedModel: (
    content: NrrdMesh[],
    mousePosition: { x: number, y: number },
  ) => { intersectedObject: unknown | null }
  /**
   * `copperSceneOnDemond`'s constructor does
   * `window.addEventListener("resize", this.confirmResize, false)`
   * (Scene/copperSceneOnDemond.js:9-12,27) and nothing in copper3d ever
   * calls the matching `removeEventListener` -- every scene this renderer
   * creates leaks that listener (and everything it closes over) for the
   * life of the page. `confirmResize` is declared public on the class
   * (Scene/copperSceneOnDemond.d.ts), assigned to `this` before the
   * `addEventListener` call runs, so reading it back through this type is
   * the exact same function reference that got registered --
   * `window.removeEventListener('resize', scene.confirmResize, false)`
   * (capture flag matching the original `false`) genuinely unsubscribes
   * it. useModalityScene does this immediately after every `createScene`
   * call, not deferred to its own scope disposal: useCopperStage's
   * ResizeObserver already calls `getCurrentScene().onWindowResize()` on
   * every container resize (review fix #1), so `confirmResize`'s
   * window-resize wiring is redundant the instant a scene exists, and
   * removing it up front rather than at teardown makes the fix
   * unconditional.
   */
  confirmResize: () => void
  // No `resetView` here: it exists only on `copperScene`
  // (Scene/copperScene.d.ts:57, dist/bundle.esm.js:84635), not on
  // `baseScene`/`copperSceneOnDemond`'s prototype chain (confirmed absent
  // in Scene/baseScene.d.ts and Scene/commonSceneMethod.d.ts). Task 9/10's
  // "reset view" affordance and camera choreography need to build that
  // behaviour from what baseScene *does* provide instead: `loadView`
  // above, plus `getDefaultViewPoint`/`setViewPoint` if this interface
  // grows to need them.
}

export interface CopperRenderer {
  /**
   * `copperRendererOnDemond`'s own `.d.ts` (Renderer/copperRendererOnDemond.d.ts:7)
   * declares this as `copperScene | baseScene | copperMScene` -- a type
   * shared with the base renderer class. In practice, for this renderer,
   * `createScene` only ever stores `copperSceneOnDemond` instances in its
   * scene map (dist/bundle.esm.js:84332-84354), so `CopperScene` above,
   * not that broader union, is what's actually returned here.
   */
  getSceneByName: (name: string) => CopperScene | undefined
  /**
   * `createScene(name)` checks `sceneMap[name]` and, if unset, synchronously
   * constructs the new scene and stores it there *before* returning --
   * registration happens whether or not any content ever successfully loads
   * into that scene afterward.
   *
   * `opt` is copper3d 3.9.0. `{ controls: 'copper3d' }` builds the scene
   * with `Copper3dTrackballControls` (and turns on its `updateOnInput`)
   * instead of the default `OrbitControls`; before 3.9.0 this class
   * hardcoded OrbitControls and the instance had to be swapped out
   * afterwards. The renderer's own `options.controls` is deliberately not
   * consulted -- it never had any effect here, so honouring it now would
   * change behaviour for anyone who set it and never noticed.
   */
  createScene: (
    name: string,
    opt?: { controls?: 'copper3d' | 'orbit' | 'trackball' },
  ) => CopperScene | undefined
  /**
   * `copperRendererOnDemond.sceneMap` (Renderer/copperRendererOnDemond.js:
   * 2-3,15-16,25-33) is declared `private` in the `.d.ts`
   * (Renderer/copperRendererOnDemond.d.ts:5), but that's TypeScript-only:
   * at runtime it's a plain `{}` object assigned with `this.sceneMap = {}`
   * and read/written with ordinary bracket access, not a real ECMAScript
   * private field. There is no public eviction method anywhere in
   * copper3d -- once `createScene` registers a name, nothing removes it
   * again except deleting this property directly. Review round 2, fix #1:
   * useModalityScene needs exactly this to stop a scene whose *content*
   * failed to load (stall, timeout, bad view-preset) from sitting in the
   * cache forever, indistinguishable from a real successful load on the
   * next `getSceneByName` call.
   */
  sceneMap: Record<string, CopperScene>
  setCurrentScene: (scene: CopperScene) => void
  /**
   * Inherited from `baseRenderer` (Renderer/baseRenderer.d.ts:24). Typed
   * as `CopperBaseScene`, not `CopperScene` (round-2 review fix #3): the
   * placeholder scene this returns before `setCurrentScene` is ever
   * called is a real `baseScene`, which has no `loadGltf`/`loadNrrd`/
   * `controls` -- the wider `CopperScene` type let those compile here and
   * then throw at runtime. Widen the call site with a cast only where the
   * caller has independently established the current scene really is a
   * `copperSceneOnDemond` (e.g. right after this renderer's own
   * `createScene`/`setCurrentScene`).
   */
  getCurrentScene: () => CopperBaseScene
  render: () => void
  /**
   * Non-optional: `baseRenderer.d.ts` declares both `stop()` and
   * `dispose()` without `?`. Typing them optional here let a call site
   * write `renderer.value?.stop?.()`, which silently no-ops with no
   * compile error if either is ever renamed upstream -- exactly the
   * teardown design doc §12.5 depends on. Verified `dispose()`
   * (dist/bundle.esm.js:69962-69974) really does free the GPU context
   * (`renderer.dispose()` + `renderer.forceContextLoss()`), not just stop
   * the loop.
   */
  stop: () => void
  dispose: () => void
}

/**
 * The parts of `import('copper3d')` reached through the module handle rather
 * than as plain imports -- the classes, which have to be constructed against
 * copper3d's own copy of three, and the loading bar `loadNrrd` writes into.
 *
 * Everything that is a free function (`fitView`, `beginGesture`,
 * `addVolumeBoundingBox`, the dispose and crossfade helpers, ...) is imported
 * normally through `copperExtras.ts` instead.
 */
export interface CopperModule {
  copperRendererOnDemond: new (
    container: HTMLDivElement,
    options?: Record<string, unknown>,
  ) => CopperRenderer
  loading: (svg?: string) => LoadingBar
}

/** useCopperStage's return contract; Tasks 8-10 depend on it. */
export interface StageApi {
  renderer: Ref<CopperRenderer | undefined>
  Copper: Ref<CopperModule | undefined>
  ready: Ref<boolean>
  /** Set if the dynamic `import('copper3d')` itself rejects (e.g. a chunk
   * load failure). Otherwise stays undefined -- this is not a general
   * error channel, just this one failure mode surfaced instead of an
   * unhandled rejection. */
  loadError: Ref<Error | undefined>
  requestContinuous: () => void
  releaseContinuous: () => void
  /**
   * The stage host's current width / height, measured fresh off
   * `getBoundingClientRect()` on every call rather than cached -- panel
   * collapse/three-up resize the host with no event this composable would
   * otherwise see in time. Returns 1 (square) for a zero-height or
   * not-yet-laid-out box: `fitDistance` already tolerates a bad aspect, but
   * 1 is a more honest "don't know yet" than 0 or `Infinity`.
   */
  aspect: () => number
}
