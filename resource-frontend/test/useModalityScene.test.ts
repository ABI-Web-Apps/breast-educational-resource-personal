import { effectScope, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Modality } from '../src/content/types'
import type { CopperModule, CopperRenderer, CopperScene, CopperViewPoint, StageApi } from '../src/composables/copper-types'
import { VOLUME_BOUNDS_NAME, createSceneBudget, installFastSliceRepaint, setDracoDecoderPath } from '../src/composables/copperExtras'
import { useModalityScene } from '../src/composables/useModalityScene'

/**
 * useModalityScene drives copper3d's own loaders (`scene.loadNrrd` and
 * `scene.loadGltf`, both faked below) -- happy-dom has no WebGL and cannot
 * decode a real GLB/NRRD file. What's under test here is the bookkeeping
 * around those calls: scene naming/reuse, the resize-listener leak
 * workaround, failure detection (a no-progress stall for NRRD, a wall-clock
 * timeout under `onError` for GLB), the stale-load bookkeeping guard,
 * disposal safety, the view-preset render-after-fetch sequencing, and the
 * ultrasound control flags.
 */

/**
 * Extends test/setup.ts's own mock of this barrel. `setDracoDecoderPath` is
 * a spy here so the subpath-deploy test can assert what the decoder was
 * pointed at without a real decoder existing.
 */
vi.mock('../src/composables/copperExtras', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/composables/copperExtras')>()),
  installFastSliceRepaint: vi.fn(async () => {}),
  setDracoDecoderPath: vi.fn(),
}))

/**
 * Stands in for `scene.loadGltf(url, onLoad, opts)`. Module-level so a test
 * can queue behaviour before the scene it will land on exists.
 *
 * Copper3d's own `loadGltf` adds the group to the scene itself, so the fake
 * scene does too -- `loadGlb` no longer adds anything, and a fake that left
 * the group out would hide that.
 */
const gltfLoad = vi.fn<(url: string, onLoad: (group: any) => void, opts?: any) => void>()

/** Queues the next `loadGltf` to succeed with `group`. */
function resolveGltfWith(group: unknown) {
  gltfLoad.mockImplementationOnce((_url, onLoad) => { onLoad(group) })
}

/** A group shaped enough for `tintFatLayer`'s traverse and the Box3 measure. */
function plainGroup() {
  return { name: '', traverse: () => {} }
}

const DEFAULT_VIEWPOINT: CopperViewPoint = {
  farPlane: 1000, nearPlane: 0.01, eyePosition: [0, 0, 1], targetPosition: [0, 0, 0], upVector: [0, 1, 0],
}

function makeModality(overrides: Partial<Modality> = {}): Modality {
  return {
    id: 'mammogram',
    label: '3D Mammogram',
    asset: 'density-1/middle/m3d.nrrd',
    viewPreset: 'density-1/middle/m_view.json',
    text: '<p>copy</p>',
    keyFacts: [],
    ...overrides,
  }
}

/**
 * `scene.add`/`remove`/`getObjectByName` and `addObject` are backed by a
 * real array rather than bare spies, because two things under test here
 * genuinely read the scene back: §7.1's morph finds the outgoing model by
 * name, and eviction finds everything it has to dispose the same way. A
 * `getObjectByName` that always returned undefined would let both of those
 * "pass" by doing nothing at all.
 */
/**
 * What `createScene(name, { controls: 'copper3d' })` leaves on
 * `scene.controls`: a `Copper3dTrackballControls`, with the trackball's own
 * `noRotate`/`noPan` spelling rather than OrbitControls' `enableRotate`/
 * `enablePan`. Writing the wrong pair is a silent no-op on the real class,
 * which is how every flat view stayed rotatable for so long, so the double
 * deliberately carries only the names the real object has.
 */
function makeTrackballDouble() {
  return {
    rotateSpeed: 1,
    panSpeed: 0.3,
    noRotate: false,
    noPan: false,
    staticMoving: false,
    updateOnInput: true,
    enabled: true,
    handleResize: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispose: vi.fn(),
  }
}

/**
 * Task 3 (three-up plan): `refitCurrentScene` reads `camera.fov` and writes
 * `camera.position`/`updateProjectionMatrix`. Every fixture scene loads
 * successfully and gets bounds recorded (a real `RASDimensions`/measured
 * Box3 for imaging, or nothing for the plain-object GLB fakes here -- see
 * `loadAnatomy`'s own try/catch), so the refit genuinely runs against these
 * fakes on most loads, not just the tests that care about it.
 */
function makeFakeCamera() {
  return {
    fov: 45,
    position: { x: 0, y: 0, z: 0, set: vi.fn() },
    up: { x: 0, y: 1, z: 0, set: vi.fn() },
    lookAt: vi.fn(),
    updateProjectionMatrix: vi.fn(),
  }
}

function makeFakeScene(): CopperScene {
  const objects: Array<{ name: string }> = []
  const add = vi.fn((obj: { name: string }) => { objects.push(obj) })
  const scene = {
    camera: makeFakeCamera() as unknown as CopperScene['camera'],
    controls: makeTrackballDouble(),
    renderer: { domElement: document.createElement('canvas') },
    sceneName: '',
    requestRenderIfNotRequested: vi.fn(),
    objects,
    scene: {
      add,
      remove: vi.fn((obj: { name: string }) => {
        const at = objects.indexOf(obj)
        if (at !== -1) objects.splice(at, 1)
      }),
      getObjectByName: vi.fn((name: string) => objects.find(o => o.name === name)),
      // Same live array `add`/`remove` mutate, mirroring three's
      // `Object3D.children` -- finding 2's fix sweeps whatever is actually
      // IN the scene graph rather than a hardcoded list of names, so
      // `evictScene` needs this to find anything at all.
      children: objects,
    },
    // copper3d's own addObject is `this.scene.add(obj)` (bundle.esm.js:68800).
    addObject: vi.fn((obj: { name: string }) => { objects.push(obj) }),
    loadNrrd: vi.fn(),
    // Routed through the module-level spy, but the `scene.add` is done HERE
    // because copper3d's own `loadGltf` does it -- `loadGlb` adds nothing.
    loadGltf: vi.fn((url: string, onLoad: (g: any) => void, opts?: unknown) =>
      gltfLoad(url, (group) => { add(group); onLoad(group) }, opts)),
    loadView: vi.fn(),
    onWindowResize: vi.fn(),
    confirmResize: vi.fn(),
    pickSpecifiedModel: vi.fn(() => ({ intersectedObject: null })),
  }
  return scene as unknown as CopperScene & { objects: Array<{ name: string }> }
}

/** A single fixed scene, for tests that only ever touch one. `sceneMap` is
 * a real object `createScene`'s default mock populates, mirroring
 * copper3d's own synchronous "register before content loads" behavior
 * (Renderer/copperRendererOnDemond.js:25-33) closely enough for the
 * eviction-on-failure tests to observe it directly. Tests that override a
 * specific `createScene` call via `mockReturnValueOnce` bypass this
 * default (Vitest doesn't run the base implementation for a `*Once`
 * override) -- fine, since only the eviction tests below inspect
 * `sceneMap` at all. */
function makeFakeRenderer(scene: CopperScene): CopperRenderer {
  const sceneMap: Record<string, CopperScene> = {}
  return {
    sceneMap,
    getSceneByName: vi.fn(() => undefined),
    createScene: vi.fn((name: string, _opt?: unknown) => {
      sceneMap[name] = scene
      return scene
    }),
    setCurrentScene: vi.fn(),
    getCurrentScene: vi.fn(() => ({ onWindowResize: vi.fn() })),
    render: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  }
}

/** Real DOM nodes, matching what `Copper.loading()` actually returns. */
function makeLoadingBar() {
  return { loadingContainer: document.createElement('div'), progress: document.createElement('div') }
}

function makeFakeCopperModule(): CopperModule {
  return {
    copperRendererOnDemond: vi.fn() as unknown as CopperModule['copperRendererOnDemond'],
    loading: vi.fn(() => makeLoadingBar()),
  }
}

function makeFakeStage(renderer: CopperRenderer): StageApi {
  return {
    renderer: shallowRef(renderer),
    Copper: shallowRef(makeFakeCopperModule()),
    ready: shallowRef(true),
    loadError: shallowRef(undefined),
    requestContinuous: vi.fn(),
    releaseContinuous: vi.fn(),
    // Fixed at 1 (square): no test here cares about a non-square host, and
    // `orbitFraming.test.ts` already covers `fitDistance`'s own aspect handling
    // in isolation.
    aspect: vi.fn(() => 1),
  }
}

/** Every successful load fetches its view-preset JSON directly (review fix
 * #5) -- stubbed globally so tests that don't care about it don't need to
 * repeat this, and overridden per-test where the response matters. */
function stubFetchOk(data: CopperViewPoint = DEFAULT_VIEWPOINT) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })))
}

describe('useModalityScene', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubFetchOk()
    // `mockReset` (not `mockClear`) so a previous test's queued
    // `mockImplementationOnce` behaviour and call history never leak into
    // the next one; the default below stands in for a GLB that loads.
    gltfLoad.mockReset()
    gltfLoad.mockImplementation((_url, onLoad) => { onLoad(plainGroup()) })
    vi.mocked(setDracoDecoderPath).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    // Not vi.unstubAllGlobals(): that would also wipe test/setup.ts's
    // useAssetUrl/useRuntimeConfig stubs, which are only ever installed
    // once (setupFiles runs before the whole file, not per test). Each
    // test's beforeEach re-stubs `fetch` on top instead.
  })

  it('does nothing before the stage is ready', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    stage.ready.value = false

    const modalityScene = useModalityScene(stage)
    await modalityScene.load('the-breast', makeModality())

    expect(renderer.createScene).not.toHaveBeenCalled()
  })

  it('creates a scene namespaced by slug:modalityId and switches the renderer to it', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'density-1/right/mri.nrrd' }))
    // `controls: 'copper3d'` is the trackball, which is also what turns on
    // `updateOnInput` -- without it an on-demand viewer ignores the mouse.
    expect(renderer.createScene).toHaveBeenCalledWith(
      '/modelView/density-1/right/mri.nrrd',
      { controls: 'copper3d' },
    )
    expect(renderer.setCurrentScene).toHaveBeenCalledWith(scene)

    // Resolve loadNrrd's callback synchronously, as a fast local fixture load would.
    const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
    callback(fakeVolume(), fakeMeshes(), { z: fakeSlice() })
    await loadPromise

    expect(modalityScene.scene.value).toBe(scene)
    expect(modalityScene.loading.value).toBe(false)
    // Review fix #5: the view preset is fetched and applied via loadView,
    // not the fire-and-forget loadViewUrl, so there is a completion signal
    // to render after.
    expect(scene.loadView).toHaveBeenCalledWith(DEFAULT_VIEWPOINT)
    // Task 9 controller correction C2: the fetched preset is also exposed
    // as data (not just applied instantly), so a camera flight has
    // something to interpolate toward instead of only ever jumping there.
    expect(modalityScene.viewpoint.value).toEqual(DEFAULT_VIEWPOINT)
  })

  /**
   * The wireframe box is the only thing giving a lone slice plane spatial
   * context. It used to be added by an app-local async helper, and a
   * fire-and-forget call landed it one microtask after `load()` had drawn
   * its only frame -- invisible until the reader touched the canvas.
   * copper3d's `addVolumeBoundingBox` is synchronous, so it cannot race the
   * render at all; what is left to hold is that it is called, sized from the
   * volume, and in the scene by the time the frame is drawn.
   */
  it('puts the volume bounding box in the scene before the frame is drawn', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const objects = (scene as unknown as { objects: Array<{ name: string }> }).objects

    vi.mocked(renderer.render).mockImplementation(() => {
      expect(
        objects.some(o => o.name === VOLUME_BOUNDS_NAME),
        'a frame was drawn before the box existed',
      ).toBe(true)
    })

    const load = modalityScene.load(
      'density-a',
      makeModality({ id: 'mri', asset: 'density-1/right/mri.nrrd' }),
    )
    const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
    callback(fakeVolume(), fakeMeshes(), { z: fakeSlice() })
    await load

    expect(renderer.render).toHaveBeenCalled()
    expect(objects.filter(o => o.name === VOLUME_BOUNDS_NAME)).toHaveLength(1)
  })

  it('reuses an existing scene instead of recreating it or re-downloading', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const modality = makeModality()

    const first = modalityScene.load('the-breast', modality)
    const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
    callback(fakeVolume(), fakeMeshes(), { z: fakeSlice() })
    await first

    vi.mocked(renderer.getSceneByName).mockReturnValueOnce(scene)
    await modalityScene.load('the-breast', modality)

    expect(renderer.createScene).toHaveBeenCalledTimes(1)
    expect(scene.loadNrrd).toHaveBeenCalledTimes(1)
    expect(renderer.setCurrentScene).toHaveBeenLastCalledWith(scene)
  })

  // Review fix #1: copperSceneOnDemond's OrbitControls listens on the
  // *shared* canvas regardless of which scene is "current" -- leaving a
  // previous scene's controls enabled means dragging the mouse still
  // requests a render of that scene too, and the last-created scene wins.
  it('disables the outgoing scene\'s controls and enables the incoming one on every switch', async () => {
    const sceneA = makeFakeScene()
    const sceneB = makeFakeScene()
    const renderer = makeFakeRenderer(sceneA)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadA = modalityScene.load('the-breast', makeModality({ id: 'mammogram' }))
    resolveNrrd(sceneA)
    await loadA
    expect(sceneA.controls.enabled).toBe(true)

    vi.mocked(renderer.createScene).mockReturnValueOnce(sceneB)
    const loadB = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    resolveNrrd(sceneB)
    await loadB

    expect(sceneA.controls.enabled).toBe(false)
    expect(sceneB.controls.enabled).toBe(true)
  })

  it('re-enables a cached scene\'s controls and disables whatever was active when switching back to it', async () => {
    const sceneA = makeFakeScene()
    const sceneB = makeFakeScene()
    const renderer = makeFakeRenderer(sceneA)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const modalityA = makeModality({ id: 'mammogram' })

    const loadA = modalityScene.load('the-breast', modalityA)
    resolveNrrd(sceneA)
    await loadA

    vi.mocked(renderer.createScene).mockReturnValueOnce(sceneB)
    const loadB = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    resolveNrrd(sceneB)
    await loadB
    expect(sceneA.controls.enabled).toBe(false)

    // Switch back to the cached mammogram scene.
    vi.mocked(renderer.getSceneByName).mockReturnValueOnce(sceneA)
    await modalityScene.load('the-breast', modalityA)

    expect(sceneB.controls.enabled).toBe(false)
    expect(sceneA.controls.enabled).toBe(true)
  })

  // Task 9 controller correction C2's `viewpoint` ref, mirroring
  // sliceStateByScene's per-scene caching: switching back to a cached scene
  // must restore ITS OWN preset, not whichever scene's preset fetch
  // resolved last.
  it('restores each cached scene\'s own view preset when switching back to it', async () => {
    const sceneA = makeFakeScene()
    const sceneB = makeFakeScene()
    const renderer = makeFakeRenderer(sceneA)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const modalityA = makeModality({ id: 'mammogram' })
    const viewpointA: CopperViewPoint = { ...DEFAULT_VIEWPOINT, eyePosition: [1, 1, 1] }
    const viewpointB: CopperViewPoint = { ...DEFAULT_VIEWPOINT, eyePosition: [2, 2, 2] }

    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(viewpointA) } as Response))
    const loadA = modalityScene.load('the-breast', modalityA)
    resolveNrrd(sceneA)
    await loadA
    expect(modalityScene.viewpoint.value).toEqual(viewpointA)

    vi.mocked(renderer.createScene).mockReturnValueOnce(sceneB)
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(viewpointB) } as Response))
    const loadB = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    resolveNrrd(sceneB)
    await loadB
    expect(modalityScene.viewpoint.value).toEqual(viewpointB)

    // Switch back to the cached mammogram scene -- its own preset, not B's.
    vi.mocked(renderer.getSceneByName).mockReturnValueOnce(sceneA)
    await modalityScene.load('the-breast', modalityA)
    expect(modalityScene.viewpoint.value).toEqual(viewpointA)
  })

  it('installs a trackball on every scene and leaves 3D modalities rotatable', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality({ id: 'mri' }))
    resolveNrrd(scene)
    await loadPromise

    // The controls object is the REPLACEMENT, not the OrbitControls copper3d
    // built -- if `installTrackballControls` stopped running, `noRotate`
    // would be undefined here rather than false.
    expect(scene.controls.noRotate).toBe(false)
    expect(scene.controls.noPan).toBe(false)
    expect(scene.controls.staticMoving).toBe(true)
    // Half the legacy app's 3.0: `updateOnInput` integrates the whole
    // gesture instead of only the last event before each frame, so the same
    // number now produces several times more rotation. See the source.
    expect(scene.controls.rotateSpeed).toBe(1.5)
  })

  // Review fix #1 (second half): the resize listener is removed the moment
  // the scene is created, not deferred to this composable's own scope
  // disposal -- proven here by never disposing anything at all.
  it('removes a newly created scene\'s leaked resize listener immediately, before any window resize can reach it', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    // Simulates copperSceneOnDemond's own constructor
    // (Scene/copperSceneOnDemond.js:27), which the fake renderer above
    // does not reproduce itself.
    window.addEventListener('resize', scene.confirmResize, false)

    const loadPromise = modalityScene.load('the-breast', makeModality())
    resolveNrrd(scene)
    await loadPromise

    window.dispatchEvent(new Event('resize'))

    expect(scene.confirmResize).not.toHaveBeenCalled()
  })

  // Review fix #2: neither loadGltf nor loadNrrd ever receives an onError,
  // so a genuinely dead connection needs its own detection. A flat
  // wall-clock timeout was replaced with stall detection specifically so a
  // slow-but-healthy transfer is never misreported as failed -- proven
  // below by a load that keeps receiving progress well past what a 30s
  // wall clock would have allowed.
  it('does not fail an NRRD load that keeps receiving progress, even past a 30s wall clock', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const bar = captureNextLoadingBar(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality())

    // Three progress events, 10s apart -- 30s total, each comfortably
    // inside the 15s stall window individually.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      nrrdProgress(scene, (i + 1) * 20, 100)
      await flushMicrotasks()
    }

    resolveNrrd(scene)
    await loadPromise

    expect(modalityScene.loadError.value).toBeUndefined()
  })

  it('fails an NRRD load with no progress for the stall window, without waiting for a fixed deadline', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality())
    await vi.advanceTimersByTimeAsync(15_000)
    await loadPromise

    expect(modalityScene.loadError.value).toBeInstanceOf(Error)
    expect(modalityScene.loading.value).toBe(false)
  })

  // Review round 2, fix #1: createScene() registers the scene in
  // copper3d's own sceneMap synchronously, before any content loads
  // (Renderer/copperRendererOnDemond.js:25-33). A scene whose content then
  // fails used to stay registered forever -- fix #3 (the previous round)
  // only handled a *superseded* load, not a genuinely *failed* one, so a
  // failed load followed by a return visit used to hit the poisoned entry,
  // silently clear loadError/loading, and land on a permanently blank,
  // unframed stage with no way to retry.
  it('evicts a scene from copper3d\'s own map when its content fails to load, so a retry actually rebuilds it', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    const modality = makeModality()
    const name = '/modelView/density-1/middle/m3d.nrrd'

    const firstLoad = modalityScene.load('the-breast', modality)
    // createScene's default mock registers into sceneMap synchronously,
    // exactly like the real renderer.
    expect(renderer.sceneMap[name]).toBe(scene)

    await vi.advanceTimersByTimeAsync(15_000) // stalls out
    await firstLoad
    expect(modalityScene.loadError.value).toBeInstanceOf(Error)

    // The poisoned entry must be gone -- otherwise a retry's own
    // getSceneByName(name) would find it and treat it as a valid,
    // silently-broken cache hit instead of reloading.
    expect(renderer.sceneMap[name]).toBeUndefined()

    // Retry: a real copper3d renderer would also report nothing for this
    // name now that the entry is deleted.
    const retryScene = makeFakeScene()
    vi.mocked(renderer.createScene).mockReturnValueOnce(retryScene)
    const retry = modalityScene.load('the-breast', modality)
    resolveNrrd(retryScene)
    await retry

    expect(modalityScene.loadError.value).toBeUndefined()
    expect(modalityScene.scene.value).toBe(retryScene)
    // Not just "a load was attempted" -- the bookkeeping a return visit
    // depends on (Task 10's slice slider included) must actually be there.
    expect(modalityScene.sliceState.value).not.toBeNull()
    expect(retryScene.loadView).toHaveBeenCalledWith(DEFAULT_VIEWPOINT)
  })

  it('reports the real fraction downloaded', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality())
    nrrdProgress(scene, 42, 100)
    await flushMicrotasks()

    expect(modalityScene.progress.value).toBeCloseTo(0.42)

    resolveNrrd(scene)
    await loadPromise
  })

  // Review round 2, fix #3: a gzipped or chunked response has no
  // Content-Length, so `event.total` is 0. Bytes are still arriving, there
  // is just no fraction to express -- freezing `progress` at whatever it
  // last held (0, on the very first event) reads as a stuck download.
  it('treats a missing Content-Length as indeterminate, not stuck at 0', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality())
    nrrdProgress(scene, 4096, 0)
    await flushMicrotasks()

    expect(modalityScene.progress.value).toBeNaN()

    resolveNrrd(scene)
    await loadPromise
  })

  it('surfaces a GLB load that never calls back through loadError after its own timeout', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)
    // the loadGltf fake never calls back, simulating a genuinely dead
    // connection -- it has a real onError unlike copper3d's own loadGltf,
    // but nothing here ever calls it, so the flat wall-clock timeout in
    // `loadGlb` (GLB_LOAD_TIMEOUT_MS) is the only way out.
    gltfLoad.mockImplementationOnce(() => {})

    const loadPromise = modalityScene.load('density-a', makeModality({
      id: 'anatomy', label: 'Anatomy', asset: 'density-1/left/density25.glb', viewPreset: 'left_breast_view.json',
    }))
    await vi.advanceTimersByTimeAsync(60_000)
    await loadPromise

    expect(modalityScene.loadError.value).toBeInstanceOf(Error)
    expect(modalityScene.loading.value).toBe(false)
  })

  it('does not let a superseded load\'s late failure clobber a newer, successful load', async () => {
    const stalledScene = makeFakeScene()
    const freshScene = makeFakeScene()
    const renderer = makeFakeRenderer(stalledScene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    // First load for modality A never receives any progress (simulates a
    // stalled request).
    void modalityScene.load('the-breast', makeModality({ id: 'mammogram' }))

    // User switches to modality B before A's stall timer fires; B succeeds.
    vi.mocked(renderer.createScene).mockReturnValueOnce(freshScene)
    const secondLoad = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    resolveNrrd(freshScene)
    await secondLoad

    // Now let A's stall timer fire.
    await vi.advanceTimersByTimeAsync(15_000)

    expect(modalityScene.loadError.value).toBeUndefined()
    expect(modalityScene.loading.value).toBe(false)
    expect(modalityScene.scene.value).toBe(freshScene)
  })

  // Review round 2, fix #2: the progress handler had no token guard, so
  // once a load was superseded, its own late progress events still landed
  // in the shared `progress` ref -- once design doc §13.1's progress ring
  // is wired to this value, that would jitter between two unrelated
  // downloads.
  it('does not let a superseded load\'s own progress events touch the current progress ref', async () => {
    const stalledScene = makeFakeScene()
    const freshScene = makeFakeScene()
    const renderer = makeFakeRenderer(stalledScene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    void modalityScene.load('the-breast', makeModality({ id: 'mammogram' }))

    vi.mocked(renderer.createScene).mockReturnValueOnce(freshScene)
    const secondLoad = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    nrrdProgress(freshScene, 10, 100)
    await flushMicrotasks()

    expect(modalityScene.progress.value).toBeCloseTo(0.1)

    // The superseded (mammogram) load's own progress event arrives late --
    // must not overwrite the current (mri) load's progress, still in
    // flight at 10%.
    nrrdProgress(stalledScene, 77, 100)
    await flushMicrotasks()

    expect(modalityScene.progress.value).toBeCloseTo(0.1)

    resolveNrrd(freshScene)
    await secondLoad
    // Lets the stalled load's own stall timer fire so it doesn't leak a
    // pending timer into a later test.
    await vi.advanceTimersByTimeAsync(15_000)
  })

  // Review fix #3: the earlier guard returned before finishing the stale
  // scene's own bookkeeping, so it sat in copper3d's cache forever with no
  // slice state and no camera preset. It must still be usable once the
  // user switches back to it, even though its own load lost the race.
  it('still completes a superseded load\'s scene bookkeeping, so switching back to it later is properly framed', async () => {
    const staleScene = makeFakeScene()
    const freshScene = makeFakeScene()
    const renderer = makeFakeRenderer(staleScene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const firstLoad = modalityScene.load('the-breast', makeModality({ id: 'mammogram' }))

    vi.mocked(renderer.createScene).mockReturnValueOnce(freshScene)
    const secondLoad = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
    resolveNrrd(freshScene)
    await secondLoad

    // A's own network response finally arrives, late.
    const staleSlice = fakeSlice({ index: 8, MaxIndex: 30, spacing: [1, 1, 2] })
    resolveNrrd(staleScene, staleSlice)
    await firstLoad

    // Switching back to modality A should find a fully-framed cached scene.
    vi.mocked(renderer.getSceneByName).mockReturnValueOnce(staleScene)
    await modalityScene.load('the-breast', makeModality({ id: 'mammogram' }))

    expect(modalityScene.sliceState.value!.max).toBe(30)
    expect(modalityScene.sliceState.value!.raw).toStrictEqual(staleSlice)
    expect(staleScene.loadView).toHaveBeenCalledWith(DEFAULT_VIEWPOINT)
  })

  // Review fix #4: there is no way to cancel loadNrrd/loadGltf's in-flight
  // XHR, so a response can still arrive after the owning component (and
  // its renderer) has already been torn down. Nothing from that point on
  // should touch the (possibly disposed) renderer or the live refs.
  it('ignores a load that resolves after its owning scope has been disposed', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)

    const scope = effectScope()
    const modalityScene = scope.run(() => useModalityScene(stage))!
    void modalityScene.load('the-breast', makeModality())

    scope.stop()
    resolveNrrd(scene)
    await flushMicrotasks()

    expect(modalityScene.sliceState.value).toBeNull()
    expect(modalityScene.loadError.value).toBeUndefined()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('locks rotation and pan for the 2D ultrasound modality via noRotate/noPan', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('benign-cyst', makeModality({
      id: 'ultrasound', label: '2D Ultrasound', asset: 'benign-cyst/middle/u2d.nrrd',
    }))
    resolveNrrd(scene)
    await loadPromise

    expect(scene.controls.noRotate).toBe(true)
    expect(scene.controls.noPan).toBe(true)
    expect(modalityScene.sliceState.value).toBeNull()
  })

  it('carries the z slice, its depth and its mesh -- and no copy of the current index', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality({ id: 'mri' }))
    const slice = fakeSlice({ index: 6, MaxIndex: 40, spacing: [1, 1, 2] })
    resolveNrrd(scene, slice)
    await loadPromise

    // `mesh` travels with the slice it paints: useSliceControl raycasts the
    // z plane to tell a slice scrub from a camera orbit.
    //
    // The exact shape is the assertion (fix round 1, Important). There must
    // be no `index` field: it was written once at load and never again,
    // while the real position moved in `raw.index`, so anything reading it
    // after a cached scene came back into view read a stale number. Adding
    // one back here would fail this test, which is the point.
    expect(Object.keys(modalityScene.sliceState.value!).sort()).toEqual(['max', 'mesh', 'raw'])
    expect(modalityScene.sliceState.value!.max).toBe(40)
    expect(modalityScene.sliceState.value!.raw).toStrictEqual(slice)
    expect(modalityScene.sliceState.value!.mesh.name).toBe('z')
  })

  // Finding 2 (code review, Important). copper3d's `loadNrrd` builds a full
  // VolumeSlice -- its own PlaneGeometry, its own MeshBasicMaterial, its own
  // canvas-backed Texture -- for x, y AND z (verified directly against
  // node_modules/copper3d/dist/bundle.esm.js's `VolumeSlice` constructor and
  // `Volume.extractSlice`), but this app only ever displays `meshes.z`. x
  // and y are never added to any scene, so `evictScene`'s traversal can
  // never reach them either way -- they were simply leaking forever, kept
  // alive by `volume.sliceList` off the very `slices.z.volume` this
  // composable caches long-term. Chosen fix: dispose them immediately at
  // load time, since nothing in this app is ever going to need them.
  it('never extracts the x and y slice planes, since nothing ever displays them', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality({ id: 'mri' }))
    const meshes = fakeMeshes()
    const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
    callback(fakeVolume(), meshes, { z: fakeSlice() })
    await loadPromise

    // They used to be extracted and disposed immediately here, which still
    // paid for two full passes over a 10-50MB buffer. copper3d 3.9.0's
    // `axes` option means they are never built at all.
    expect(nrrdOpts(scene).axes).toEqual(['z'])
    // z is the plane actually shown on the stage -- it must survive load
    // time untouched; it is only ever disposed later, on eviction.
    expect(meshes.z.geometry.dispose).not.toHaveBeenCalled()
    expect(meshes.z.material.dispose).not.toHaveBeenCalled()
    expect(meshes.z.material.map.dispose).not.toHaveBeenCalled()
  })

  /**
   * Client feedback: the MRIs are too dark. `volumeExposure.test.ts` covers
   * the curve; this covers where it is handed over, and -- the client's
   * other requirement -- that it is in place before anything is painted, so
   * nobody watches the image change colour.
   */
  describe('the MRI exposure', () => {
    /** Air, tissue, and a bright tail -- the shape that made copper3d's
     *  min/max window map tissue to almost black. */
    const VOXELS = [
      ...Array.from({ length: 600 }, () => 0),
      ...Array.from({ length: 390 }, (_, i) => 100 + (i % 21)),
      ...Array.from({ length: 10 }, (_, i) => 130 + i * 52),
    ]

    /** Runs a load and returns the exposure argument handed to the repaint
     *  patch, plus how many times the slice was actually painted. */
    async function loadImaging(id: 'mri' | 'mammogram') {
      const scene = makeFakeScene()
      const stage = makeFakeStage(makeFakeRenderer(scene))
      const modalityScene = useModalityScene(stage)
      const slice = fakeSlice()
      let painted = 0
      slice.repaint = () => { painted++ }

      // The patch mock is file-wide and keeps every earlier test's calls,
      // so this has to start from a clean slate.
      const install = vi.mocked(installFastSliceRepaint)
      install.mockClear()
      install.mockResolvedValue(undefined)

      const loadPromise = modalityScene.load('the-breast', makeModality({ id, asset: `x/${id}.nrrd` }))
      const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
      callback(fakeVolume(VOXELS), fakeMeshes(), { z: slice })
      await loadPromise

      return { exposure: install.mock.calls[0]![1], painted }
    }

    it('hands the repaint patch a lift for the MRI', async () => {
      const { exposure, painted } = await loadImaging('mri')
      // Below 1 is a lift: `out = 255 * (in/255) ** exposure`.
      expect(exposure).toBeLessThan(1)
      expect(exposure).toBeGreaterThan(0)
      expect(painted).toBe(1)
    })

    it('leaves the mammogram alone, whose range the client did not report', async () => {
      const { exposure } = await loadImaging('mammogram')
      expect(exposure).toBe(1)
    })

    /**
     * Asserted as ORDERING, like the bounding box above. The lift lives in
     * the patched repaint, so painting before the patch lands draws one dark
     * frame and corrects it on the reader's first scrub -- which is the
     * colour change the client asked not to see. Holding the patch's promise
     * open is the only shape that fails against that code.
     */
    it('does not paint the slice until the patch carrying the lift is in', async () => {
      const scene = makeFakeScene()
      const renderer = makeFakeRenderer(scene)
      const modalityScene = useModalityScene(makeFakeStage(renderer))

      let installed!: () => void
      const pending = new Promise<void>((resolve) => { installed = resolve })
      const install = vi.mocked(installFastSliceRepaint)
      install.mockClear()
      install.mockReturnValueOnce(pending)

      const slice = fakeSlice()
      let painted = 0
      slice.repaint = () => { painted++ }

      const load = modalityScene.load('the-breast', makeModality({ id: 'mri', asset: 'x/mri.nrrd' }))
      const [, , , callback] = vi.mocked(scene.loadNrrd).mock.calls[0]!
      callback(fakeVolume(VOXELS), fakeMeshes(), { z: slice })

      // Microtasks, not timers: this suite runs on fake timers.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(painted, 'painted before the exposure patch landed').toBe(0)
      expect(renderer.render, 'a frame was drawn before the exposure landed').not.toHaveBeenCalled()

      installed()
      await load
      expect(painted).toBe(1)
      expect(renderer.render).toHaveBeenCalled()
    })
  })

  it('tints only the anatomy model\'s fat-layer mesh, leaving other meshes untouched', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const fatMaterial = { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, color: { set: vi.fn() }, map: { dispose: vi.fn() } }
    const otherMaterial = { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, color: { set: vi.fn() } }
    // Stable child objects, not literals built inside `traverse`: the tint
    // REPLACES `child.material`, and a literal would take the write and be
    // thrown away, leaving the test asserting against a material production
    // no longer uses.
    const fatMesh = { isMesh: true, name: 'VH_F_fat_L', material: fatMaterial as unknown }
    const glandMesh = { isMesh: true, name: 'VH_F_gland_L', material: otherMaterial as unknown }
    const group = {
      name: '',
      traverse: (fn: (child: unknown) => void) => { fn(fatMesh); fn(glandMesh) },
    }

    resolveGltfWith(group)

    await modalityScene.load('density-a', makeModality({
      id: 'anatomy', label: 'Anatomy', asset: 'density-1/left/density25.glb', viewPreset: 'left_breast_view.json',
    }))

    // The new guarantee this app now owns instead of copper3d: without this
    // call the model would decode perfectly and simply never appear.
    expect(scene.scene.add).toHaveBeenCalledWith(group)

    // The fat layer gets a NEW material, not a tweaked one. Tinting the
    // GLB's own material multiplies the tint into its flesh-toned baseColour
    // texture, which is what made the model read as mud; the legacy app
    // replaced the material outright and so does this.
    const tinted = fatMesh.material as { transparent: boolean, opacity: number, color: { getHexString: () => string } }
    expect(tinted).not.toBe(fatMaterial)
    expect(tinted.transparent).toBe(true)
    expect(tinted.opacity).toBe(0.4)
    expect(tinted.color.getHexString()).toBe('cb7830')

    // ...and the material it displaced is disposed, texture included. The
    // density morph swaps models repeatedly; leaking one per swap is the
    // difference between a bounded and an unbounded texture footprint.
    expect(fatMaterial.dispose).toHaveBeenCalledTimes(1)
    expect(fatMaterial.map.dispose).toHaveBeenCalledTimes(1)

    // Every other mesh is left exactly as the GLB authored it.
    expect(glandMesh.material).toBe(otherMaterial)
    expect(otherMaterial.transparent).toBe(false)
    expect(otherMaterial.color.set).not.toHaveBeenCalled()
  })

  it('resolves the modality asset and view-preset paths through the configured asset base', async () => {
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality({
      asset: 'density-1/middle/m3d.nrrd', viewPreset: 'density-1/middle/m_view.json',
    }))
    const [nrrdUrl] = vi.mocked(scene.loadNrrd).mock.calls[0]!
    expect(nrrdUrl).toBe('/modelView/density-1/middle/m3d.nrrd')
    resolveNrrd(scene)
    await loadPromise

    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/modelView/density-1/middle/m_view.json')
  })

  // The same deployment trap resolveAssetBase already guards against for
  // model/preset URLs (assetUrl.test.ts): three appends the decoder's file
  // names to `dracoPath` verbatim, applying no base of its own, so a GitHub
  // Pages subpath deploy that asked for `/draco/` instead of `/te-uma/draco/`
  // would 404 every anatomy model's Draco decoder.
  it('resolves the Draco decoder path against a GitHub Pages subpath deploy, not the site root', async () => {
    vi.stubEnv('BASE_URL', '/te-uma/')
    try {
      const scene = makeFakeScene()
      const renderer = makeFakeRenderer(scene)
      const stage = makeFakeStage(renderer)
      const modalityScene = useModalityScene(stage)
      resolveGltfWith(plainGroup())

      await modalityScene.load('density-a', makeModality({
        id: 'anatomy', label: 'Anatomy', asset: 'density-1/left/density25.glb', viewPreset: 'left_breast_view.json',
      }))

      expect(gltfLoad.mock.calls[0]![0])
        .toBe('/te-uma/modelView/density-1/left/density25.glb')
      // three appends the file names to this verbatim, applying no base of
      // its own, so the deployment base has to be baked in here.
      expect(setDracoDecoderPath).toHaveBeenCalledWith('/te-uma/draco/')
    }
    finally {
      // Restore the site-root default: a leaked base would corrupt every
      // asset-base assertion after this test.
      vi.unstubAllEnvs()
    }
  })

  it('surfaces a failed view-preset fetch as a load failure instead of silently keeping the default camera', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('no body')) })))
    const scene = makeFakeScene()
    const renderer = makeFakeRenderer(scene)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    const loadPromise = modalityScene.load('the-breast', makeModality())
    resolveNrrd(scene)
    await loadPromise

    expect(modalityScene.loadError.value).toBeInstanceOf(Error)
    expect(scene.loadView).not.toHaveBeenCalled()
    expect(modalityScene.viewpoint.value).toBeUndefined()
  })

  // ── §7.1 density morph ─────────────────────────────────────────────────
  //
  // The crossfade itself is not driven here: `prepareMorph` returns it as an
  // `apply`/`commit` pair precisely so useCameraChoreography's single driver
  // can run it (controller correction C8), which makes the whole thing
  // testable as plain function calls with no clock and no rAF.

  describe('prepareMorph (§7.1)', () => {
    /** A GLB group shaped like the real one: a fat-layer mesh that
     * `tintFatLayer` makes translucent amber, and an opaque gland mesh. */
    function makeAnatomyGroup() {
      const fat = {
        isMesh: true,
        name: 'VH_F_fat_L',
        geometry: { dispose: vi.fn() },
        material: { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, color: { set: vi.fn() } },
      }
      const gland = {
        isMesh: true,
        name: 'VH_F_gland_L',
        geometry: { dispose: vi.fn() },
        material: { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, color: { set: vi.fn() } },
      }
      const group = {
        name: '',
        traverse: (fn: (child: typeof fat) => void) => { fn(fat); fn(gland) },
      }
      return { group, fat, gland }
    }

    const anatomy = (asset: string) => makeModality({
      id: 'anatomy', label: 'Anatomy', asset, viewPreset: 'left_breast_view.json',
    })

    /** Loads an initial anatomy model into a fresh scene, the way a real
     * visit to `/case/density-a/anatomy` does, and hands back everything a
     * morph test needs. */
    async function loadInitialAnatomy(asset = 'density-1/left/density25.glb') {
      const scene = makeFakeScene()
      const renderer = makeFakeRenderer(scene)
      const stage = makeFakeStage(renderer)
      const modalityScene = useModalityScene(stage)

      const objects = (scene as unknown as { objects: Array<{ name: string }> }).objects
      const resolveGltf = (group: { name: string }) => { resolveGltfWith(group) }

      const initial = makeAnatomyGroup()
      resolveGltf(initial.group)
      await modalityScene.load('density-a', anatomy(asset))

      return { scene, renderer, modalityScene, initial, objects, resolveGltf }
    }

    it('crossfades in a different density\'s model without creating or switching scenes', async () => {
      const { scene, modalityScene, initial, resolveGltf } = await loadInitialAnatomy()
      const next = makeAnatomyGroup()
      resolveGltf(next.group)

      const morph = await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb'))!

      expect(morph).not.toBeNull()
      // §7.1: the SAME scene, so the camera cannot move. Only the model changes.
      expect(gltfLoad.mock.calls[1]![0]).toBe('/modelView/density-2/left/density50.glb')
      // The new guarantee this app now owns instead of copper3d: without
      // this call the incoming model would decode perfectly and simply
      // never appear.
      expect(scene.scene.add).toHaveBeenCalledWith(next.group)
      // Both models are in the scene at once, but only one answers to the
      // name -- otherwise a second morph could find the outgoing model.
      expect(next.group.name).toBe('anatomy-model')
      expect(initial.group.name).not.toBe('anatomy-model')
      // The incoming model starts invisible so the fade has somewhere to go.
      expect(next.fat.material.opacity).toBe(0)
      expect(next.gland.material.opacity).toBe(0)
    })

    // Controller correction C2. `tintFatLayer` makes the fat layer 40%
    // opaque so the fibroglandular tissue reads through it -- the whole
    // point of the density series. A crossfade that ASSIGNS opacity rather
    // than scaling it would end every morph with an opaque shell over the
    // tissue, and the incoming model would look nothing like the one it
    // replaced.
    it('ends the crossfade on the same appearance the initial load produces, tint included', async () => {
      const { scene, modalityScene, resolveGltf } = await loadInitialAnatomy()
      const next = makeAnatomyGroup()
      resolveGltf(next.group)

      const morph = (await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb')))!

      // The fully-faded-in state is the tinted one, not a blanket 1.0: a
      // crossfade that ASSIGNS opacity rather than scaling it lands here at
      // 1 and only looks right again because `commit` happens to restore it.
      morph.apply(1)
      expect(next.fat.material.opacity).toBeCloseTo(0.4, 10)

      morph.commit()

      expect(next.fat.material.opacity).toBe(0.4)
      expect(next.fat.material.transparent).toBe(true)
      // A real three material now (the tint replaces rather than mutates),
      // so this reads the resulting colour instead of a spy call.
      expect(next.fat.material.color.getHexString()).toBe('cb7830')
      expect(next.gland.material.opacity).toBe(1)
      expect(next.gland.material.transparent).toBe(false)
      expect(next.gland.material.depthWrite).toBe(true)
    })

    it('fades both models proportionally to their own base opacity', async () => {
      const { scene, modalityScene, initial, resolveGltf } = await loadInitialAnatomy()
      const next = makeAnatomyGroup()
      resolveGltf(next.group)

      const morph = (await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb')))!
      morph.apply(0.25)

      expect(next.gland.material.opacity).toBeCloseTo(0.25, 10)
      expect(initial.gland.material.opacity).toBeCloseTo(0.75, 10)
      // 0.4 base, not 1.
      expect(next.fat.material.opacity).toBeCloseTo(0.1, 10)
      expect(initial.fat.material.opacity).toBeCloseTo(0.3, 10)
      // A partly transparent mesh that still writes depth punches holes in
      // whatever is drawn behind it -- here, the other half of the fade.
      expect(next.gland.material.depthWrite).toBe(false)
      expect(initial.gland.material.depthWrite).toBe(false)
    })

    it('commit removes and disposes the outgoing model exactly once', async () => {
      const { scene, modalityScene, initial, objects, resolveGltf } = await loadInitialAnatomy()
      const next = makeAnatomyGroup()
      resolveGltf(next.group)

      // Spied AFTER the load, because the load replaces the fat layer's
      // material -- the double's own `dispose` mock belongs to a material
      // that is no longer on the mesh.
      const disposeFat = vi.spyOn(initial.fat.material as { dispose: () => void }, 'dispose')

      const morph = (await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb')))!
      morph.commit()
      morph.commit()

      expect(scene.scene.remove).toHaveBeenCalledTimes(1)
      expect(initial.fat.geometry.dispose).toHaveBeenCalledTimes(1)
      expect(disposeFat).toHaveBeenCalledTimes(1)
      expect(objects).toEqual([next.group])
    })

    // Controller correction C12: content/cases.ts:83 and :89 give
    // `the-breast` and `density-a` the same density25.glb. chooseTransition
    // correctly calls that pair one morph family, so the guard has to live
    // here -- otherwise the app downloads a second copy of the model already
    // on screen and crossfades it against its own twin for 800ms.
    it('refuses to crossfade a model against an identical copy of itself', async () => {
      const { modalityScene } = await loadInitialAnatomy('density-1/left/density25.glb')

      const morph = await modalityScene.prepareMorph('the-breast', anatomy('density-1/left/density25.glb'))

      expect(morph).toBeNull()
      expect(gltfLoad).toHaveBeenCalledTimes(1) // no second download
    })

    it('tracks what each scene actually displays, so morphing back is allowed again', async () => {
      const { scene, modalityScene, resolveGltf } = await loadInitialAnatomy('density-1/left/density25.glb')
      const next = makeAnatomyGroup()
      resolveGltf(next.group)

      const forward = (await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb')))!
      forward.commit()

      // Back to the original asset: the scene is still named
      // `density-a:anatomy`, but what it DISPLAYS is density50 now, so this
      // is a real morph rather than a no-op.
      resolveGltf(makeAnatomyGroup().group)
      expect(await modalityScene.prepareMorph('the-breast', anatomy('density-1/left/density25.glb'))).not.toBeNull()

      // ...and the one it now displays is refused.
      expect(await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb'))).toBeNull()
    })

    /**
     * Fix round 1. The outgoing model used to be renamed BEFORE the
     * incoming one was awaited, so a GLB that never arrived (the 30s
     * timeout -- copper3d has no error callback to fail faster on) left the
     * scene with nothing named `anatomy-model` at all. Every later
     * `prepareMorph` on that scene then found no previous model and
     * returned null, silently and permanently degrading §7.1 to a hard cut
     * for the rest of the session.
     */
    it('leaves the on-screen model intact when the incoming one never arrives', async () => {
      const { modalityScene, initial, objects, resolveGltf } = await loadInitialAnatomy()
      // the loadGltf fake never calls back, so the 30s wall-clock timeout
      // in `loadGlb` is what has to end this.
      gltfLoad.mockImplementationOnce(() => {})

      const attempt = modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb'))
      await expect(advanceAndSettle(attempt, 31_000)).rejects.toThrow(/Timed out/)

      expect(initial.group.name).toBe('anatomy-model')
      expect(objects).toEqual([initial.group])

      // ...and a later morph from this scene still works.
      const next = makeAnatomyGroup()
      resolveGltf(next.group)
      expect(await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb'))).not.toBeNull()
    })

    /**
     * Fix round 1. Two morphs racing on one scene would both take the same
     * outgoing model as theirs: the second would rename or remove a group
     * the first is still fading. Reachable by clicking density-b then
     * density-c before the first ~1.28MB GLB lands.
     */
    it('refuses a second morph on a scene whose incoming model is still downloading', async () => {
      const { modalityScene } = await loadInitialAnatomy()
      let land!: () => void
      gltfLoad.mockImplementationOnce((_url, onLoad) => {
        land = () => onLoad(makeAnatomyGroup().group)
      })

      const first = modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb'))
      // Second navigation arrives while the first model is still in flight.
      expect(await modalityScene.prepareMorph('density-c', anatomy('density-3/left/density75.glb'))).toBeNull()
      expect(gltfLoad).toHaveBeenCalledTimes(2) // no third download started

      land()
      expect(await first).not.toBeNull()
    })

    /**
     * Fix round 1. §7.1 suppresses `load()`, so after density-a -> density-b
     * the live scene is still registered as `density-a:anatomy`. Left alone,
     * stepping to density-b's MRI and back would miss the cache, build a
     * SECOND anatomy scene and re-download a GLB already in memory, while
     * the original sat in `sceneMap` under a name that no longer described
     * it for the life of the renderer -- which, now that the renderer
     * outlives a case navigation, is the whole session.
     */
    it('re-keys the scene under the case it now displays, so returning to that case is a cache hit', async () => {
      const { scene, modalityScene, renderer, resolveGltf } = await loadInitialAnatomy()
      expect(renderer.sceneMap['/modelView/density-1/left/density25.glb']).toBe(scene)

      resolveGltf(makeAnatomyGroup().group)
      const morph = (await modalityScene.prepareMorph('density-b', anatomy('density-2/left/density50.glb')))!
      morph.commit()

      expect(renderer.sceneMap['/modelView/density-2/left/density50.glb']).toBe(scene)
      expect(renderer.sceneMap['/modelView/density-1/left/density25.glb']).toBeUndefined()
      // copper3d keeps its own copy on the instance; a stale one would make
      // any reader of `sceneName` disagree with the map it is keyed in.
      expect(scene.sceneName).toBe('/modelView/density-2/left/density50.glb')
      // The per-scene bookkeeping travels with the name, or the re-keyed
      // scene comes back framed by whatever preset happened to load last.
      expect(modalityScene.viewpoint.value).toEqual(DEFAULT_VIEWPOINT)
    })

    it('has nothing to morph before any model has loaded, or for an imaging modality', async () => {
      const scene = makeFakeScene()
      const renderer = makeFakeRenderer(scene)
      const stage = makeFakeStage(renderer)
      const modalityScene = useModalityScene(stage)

      expect(await modalityScene.prepareMorph('the-breast', anatomy('density-1/left/density25.glb'))).toBeNull()

      const loaded = await loadInitialAnatomy()
      expect(await loaded.modalityScene.prepareMorph('density-a', makeModality({ id: 'mri' }))).toBeNull()
    })
  })

  /**
   * Task 2 (three-up plan). Residency is now bounded by bytes
   * (`sceneBudget.ts`), not by a fixed count -- every case now shares one
   * page instance, so a per-page-instance cap of three would mean fifteen
   * possible scenes fighting over three slots. These tests size an isolated
   * budget to a multiple of `FIXTURE_SCENE_BYTES` so "three scenes resident"
   * stays a meaningful, exact assertion even though the underlying unit is
   * now bytes rather than a count.
   */
  describe('cached-scene residency cap', () => {
    /** Every scene these fixtures build falls back to useModalityScene's
     *  GLB_ESTIMATED_BYTES estimate: the fake NRRD volumes built by
     *  `fakeSlice`/`resolveNrrd` carry no `raw.volume.data`, so `sceneBytes`
     *  never finds a `byteLength` to size an NRRD scene by and falls back to
     *  the same flat estimate a GLB gets. Sizing a test budget as a multiple
     *  of this keeps eviction counts predictable. */
    const FIXTURE_SCENE_BYTES = 2 * 1024 * 1024

    /** A renderer that builds a DISTINCT scene per name and answers
     * `getSceneByName` from its own map, the way the real one does --
     * `makeFakeRenderer` deliberately returns one fixed scene, which cannot
     * express eviction. */
    function makeMultiSceneRenderer() {
      const sceneMap: Record<string, CopperScene> = {}
      const renderer: CopperRenderer = {
        sceneMap,
        getSceneByName: vi.fn((name: string) => sceneMap[name]),
        createScene: vi.fn((name: string) => {
          const scene = makeFakeScene()
          sceneMap[name] = scene
          return scene
        }),
        setCurrentScene: vi.fn(),
        getCurrentScene: vi.fn(() => ({ onWindowResize: vi.fn() })),
        render: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      }
      return renderer
    }

    /** Loads one imaging modality to completion. */
    async function visit(
      modalityScene: ReturnType<typeof useModalityScene>,
      renderer: CopperRenderer,
      slug: string,
      id: 'mammogram' | 'mri',
    ) {
      const pending = modalityScene.load(slug, makeModality({ id, asset: `${slug}/${id}.nrrd` }))
      // Scenes are keyed by the resolved asset URL, not by slug:modality --
      // see `sceneName`. Two cases shipping the same file share one scene.
      const scene = renderer.sceneMap[`/modelView/${slug}/${id}.nrrd`]!
      if (vi.mocked(scene.loadNrrd).mock.calls.length) resolveNrrd(scene)
      await pending
      return scene
    }

    it('keeps three scenes and evicts the least recently used, never the one on screen', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      const a = await visit(modalityScene, renderer, 'density-a', 'mammogram')
      await visit(modalityScene, renderer, 'density-b', 'mammogram')
      await visit(modalityScene, renderer, 'density-c', 'mammogram')
      expect(Object.keys(renderer.sceneMap)).toHaveLength(3)

      await visit(modalityScene, renderer, 'density-d', 'mammogram')

      expect(Object.keys(renderer.sceneMap).sort()).toEqual([
        '/modelView/density-b/mammogram.nrrd', '/modelView/density-c/mammogram.nrrd', '/modelView/density-d/mammogram.nrrd',
      ])
      // Evicting means freeing: `scene.remove` alone only unlinks, and the
      // slice plane's texture IS the decoded volume slice.
      expect(a.scene.remove).toHaveBeenCalled()
      // ...and cutting the last reference the shared canvas holds to it.
      expect(a.controls.removeEventListener).toHaveBeenCalledWith('change', a.requestRenderIfNotRequested)
      expect(a.controls.enabled).toBe(false)
    })

    it('counts a revisit as recent, so the scene you keep coming back to is not the one thrown away', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      await visit(modalityScene, renderer, 'density-a', 'mammogram')
      await visit(modalityScene, renderer, 'density-b', 'mammogram')
      await visit(modalityScene, renderer, 'density-c', 'mammogram')
      // Back to A: it is now the most recently used, so B is the victim.
      await visit(modalityScene, renderer, 'density-a', 'mammogram')

      await visit(modalityScene, renderer, 'density-d', 'mammogram')

      expect(Object.keys(renderer.sceneMap).sort()).toEqual([
        '/modelView/density-a/mammogram.nrrd', '/modelView/density-c/mammogram.nrrd', '/modelView/density-d/mammogram.nrrd',
      ])
    })

    it('drops the evicted scene\'s own bookkeeping, so a rebuild is not handed the old scene\'s framing', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      await visit(modalityScene, renderer, 'density-a', 'mammogram')
      await visit(modalityScene, renderer, 'density-b', 'mammogram')
      await visit(modalityScene, renderer, 'density-c', 'mammogram')
      await visit(modalityScene, renderer, 'density-d', 'mammogram')

      // density-a was evicted; visiting it again must genuinely rebuild.
      const rebuilt = await visit(modalityScene, renderer, 'density-a', 'mammogram')
      expect(vi.mocked(renderer.createScene).mock.calls.filter(c => c[0] === '/modelView/density-a/mammogram.nrrd')).toHaveLength(2)
      expect(rebuilt.loadNrrd).toHaveBeenCalledTimes(1)
      expect(modalityScene.sliceState.value).not.toBeNull()
      expect(modalityScene.viewpoint.value).toEqual(DEFAULT_VIEWPOINT)
    })

    // The one place the cap must yield: never blank the stage to satisfy it.
    it('never evicts the scene currently displayed, even if it is the only one left', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      const only = await visit(modalityScene, renderer, 'density-a', 'mammogram')
      for (let i = 0; i < 5; i++) await visit(modalityScene, renderer, 'density-a', 'mammogram')

      expect(renderer.sceneMap['/modelView/density-a/mammogram.nrrd']).toBe(only)
      expect(modalityScene.scene.value).toBe(only)
    })

    // Finding 1 (code review, Important), carried forward from the
    // count-of-three cap to the byte budget. `touchScene` is the only path
    // that pins/touches a scene, and it is correctly gated behind the load
    // token so a superseded load can never bump the scene the user is
    // actually looking at. But `load()`'s bookkeeping just above it
    // (`budget.register`, review fix #3: a superseded load that genuinely
    // finished building still gets registered, so switching back to it
    // later isn't half-built) runs unconditionally, regardless of that
    // token -- so a scene built by a superseded-but-successful load must
    // still be counted against the budget, or it sits in copper3d's
    // sceneMap forever, invisible to `overflow()`. Rapid modality-stepping
    // during slow NRRD downloads is exactly the shape of traffic that hits
    // this.
    //
    // Unlike the old count-of-three cap, the budget has no special-cased
    // preference for evicting a never-viewed resident first: eviction is
    // plain LRU by registration/touch order. A's late, superseded
    // registration lands in the queue AFTER B's completion touched it, so
    // the first thing to overflow is B -- the genuinely-viewed scene that
    // happens to be LRU-oldest -- not A. What this test still proves is the
    // load-bearing part of finding 1: A is bounded, not leaked forever.
    it('registers a superseded-but-completed load against the budget, so it does not leak forever', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      // A starts loading but its NRRD response is slow.
      const loadA = modalityScene.load('density-a', makeModality({ id: 'mammogram', asset: 'density-a/mammogram.nrrd' }))
      const sceneA = renderer.sceneMap['/modelView/density-a/mammogram.nrrd']!

      // The user steps to B before A's response lands. B is not superseded
      // by anything after it, so it completes normally.
      const loadB = modalityScene.load('density-b', makeModality({ id: 'mammogram', asset: 'density-b/mammogram.nrrd' }))
      resolveNrrd(renderer.sceneMap['/modelView/density-b/mammogram.nrrd']!)
      await loadB

      // A's own response finally arrives, late -- superseded, but it still
      // built real content and must be fully registered.
      resolveNrrd(sceneA)
      await loadA
      // Never promoted to on-screen: the deliberate property this fix must
      // not disturb.
      expect(sceneA.controls.enabled).toBe(false)

      await visit(modalityScene, renderer, 'density-c', 'mammogram')
      await visit(modalityScene, renderer, 'density-d', 'mammogram')

      // Budget holds 3 scenes' worth. B is the LRU-oldest entry (touched on
      // completion, before A's own late registration), so it is the first
      // to overflow -- not A.
      expect(Object.keys(renderer.sceneMap)).toHaveLength(3)
      expect(renderer.sceneMap['/modelView/density-b/mammogram.nrrd']).toBeUndefined()
      expect(renderer.sceneMap['/modelView/density-a/mammogram.nrrd']).toBe(sceneA)

      // One more visit proves A was genuinely counted, not leaked: it is
      // now the LRU-oldest survivor and is the next thing evicted.
      await visit(modalityScene, renderer, 'density-e', 'mammogram')
      expect(Object.keys(renderer.sceneMap)).toHaveLength(3)
      expect(renderer.sceneMap['/modelView/density-a/mammogram.nrrd']).toBeUndefined()
    })

    // Shared with Task 8's failed-load eviction: one way out of the map,
    // one place that checks it took.
    it('fails loudly if a copper3d upgrade makes deleting from sceneMap a silent no-op', async () => {
      const renderer = makeMultiSceneRenderer()
      const budget = createSceneBudget(3 * FIXTURE_SCENE_BYTES)
      // Simulates `sceneMap` no longer being a plain object keyed by name:
      // the delete stops taking, but nothing throws on its own.
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)
      await visit(modalityScene, renderer, 'density-a', 'mammogram')
      await visit(modalityScene, renderer, 'density-b', 'mammogram')
      await visit(modalityScene, renderer, 'density-c', 'mammogram')

      const survivor = renderer.sceneMap['/modelView/density-a/mammogram.nrrd']!
      vi.mocked(renderer.getSceneByName).mockImplementation(
        (name: string) => name === '/modelView/density-a/mammogram.nrrd' ? survivor : renderer.sceneMap[name],
      )

      await visit(modalityScene, renderer, 'density-d', 'mammogram')
      expect(modalityScene.loadError.value?.message).toMatch(/survived disposal/)
    })

    // Task 2 (three-up plan). Three-up shows up to three panels at once, so
    // whatever a stage is currently displaying must survive ANY budget,
    // however small -- the pin is the only thing standing between a soft
    // memory limit and a blank panel the reader is looking at.
    it('never evicts the scene this stage is currently showing', async () => {
      // A budget so small that everything overflows, so the only thing that
      // can keep the visible scene alive is the pin.
      const budget = createSceneBudget(1)
      const renderer = makeMultiSceneRenderer()
      const modalityScene = useModalityScene(makeFakeStage(renderer), budget)

      resolveGltfWith(plainGroup())
      await modalityScene.load('density-a', makeModality({
        id: 'anatomy', label: 'Anatomy', asset: 'density-1/left/density25.glb', viewPreset: 'left_breast_view.json',
      }))
      await visit(modalityScene, renderer, 'density-a', 'mri')
      await visit(modalityScene, renderer, 'density-a', 'mammogram')

      // The last one loaded is the one on screen.
      expect(renderer.getSceneByName('/modelView/density-a/mammogram.nrrd')).toBeDefined()
    })
  })

  it('surfaces createScene() returning undefined through loadError rather than throwing unhandled', async () => {
    const renderer = makeFakeRenderer(makeFakeScene())
    vi.mocked(renderer.createScene).mockReturnValueOnce(undefined)
    const stage = makeFakeStage(renderer)
    const modalityScene = useModalityScene(stage)

    await modalityScene.load('the-breast', makeModality())

    expect(modalityScene.loadError.value).toBeInstanceOf(Error)
    expect(modalityScene.loading.value).toBe(false)
  })
})

/** `data`/`min`/`max` mirror what copper3d's NRRD loader leaves on the
 *  volume; the window starts at min/max, exactly as it does there. */
function fakeVolume(data: number[] = []) {
  const min = data.length ? Math.min(...data) : 0
  const max = data.length ? Math.max(...data) : 1
  return { RASDimensions: [1, 1, 1], data, min, max, windowHigh: max, repaintAllSlices: vi.fn() }
}

/** The three slice-plane meshes copper3d hands back. `z` is a real
 * traversable object because it is the one this app adds to the scene, and
 * eviction disposes it by traversal -- a bare `{ name }` would make that
 * throw here while working against a genuine THREE.Mesh. `material.map`
 * stands in for the plane's canvas-backed Texture (finding 2): a real
 * `Material.dispose()` does not cascade into it, so it needs its own spy to
 * prove something actually calls it. */
function fakeMesh(name = '') {
  const map = { dispose: vi.fn() }
  const material = { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, map }
  const geometry = { dispose: vi.fn() }
  const mesh = {
    name,
    isMesh: true,
    geometry,
    material,
    traverse(fn: (child: unknown) => void) { fn(mesh) },
  }
  return mesh
}

function fakeMeshes() {
  return { x: fakeMesh(), y: fakeMesh(), z: fakeMesh() }
}

function fakeSlice(overrides: { index?: number, MaxIndex?: number, spacing?: number[] } = {}) {
  return {
    index: overrides.index ?? 10,
    MaxIndex: overrides.MaxIndex ?? 20,
    volume: { spacing: overrides.spacing ?? [1, 1, 1] },
    repaint() {},
  }
}

/** The `opts` object copper3d's `loadNrrd` was handed on its Nth call --
 *  where `axes`, `onProgress` and `onError` live (copper3d 3.9.0). */
function nrrdOpts(scene: CopperScene, call = 0) {
  return vi.mocked(scene.loadNrrd).mock.calls[call]![4] as {
    axes?: readonly string[]
    onProgress?: (event: ProgressEvent) => void
    onError?: (error: unknown) => void
  }
}

/** Feeds one download-progress event to the Nth `loadNrrd` call. */
function nrrdProgress(scene: CopperScene, loaded: number, total: number, call = 0) {
  nrrdOpts(scene, call).onProgress?.({ loaded, total } as ProgressEvent)
}

/** Invokes the most recent `loadNrrd` call's success callback with fixture
 * data, as a fast local load would. */
function resolveNrrd(scene: CopperScene, slice = fakeSlice()) {
  const calls = vi.mocked(scene.loadNrrd).mock.calls
  const [, , , callback] = calls[calls.length - 1]!
  callback(fakeVolume(), fakeMeshes(), { z: slice })
}

/** Captures the `LoadingBar` `Copper.loading()` returns for the load
 * about to start (`load()` calls `Copper.loading()` exactly once per
 * attempt), so the test can mutate its `progress` node's text to simulate
 * copper3d's own xhr-progress handler. Returned as a getter, not the bar
 * itself, since the mock implementation below hasn't run yet at the point
 * this is called (the real bar doesn't exist until `load()` does). */
function captureNextLoadingBar(stage: StageApi): { progress: HTMLDivElement } {
  const Copper = stage.Copper.value!
  let bar: ReturnType<CopperModule['loading']> | undefined
  vi.mocked(Copper.loading).mockImplementationOnce(() => {
    bar = makeLoadingBar()
    return bar
  })
  return {
    get progress() {
      return bar!.progress
    },
  }
}

/** Runs the fake clock forward while `promise` is pending, without letting
 * its rejection race the assertion that is about to await it. */
async function advanceAndSettle<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {})
  await vi.advanceTimersByTimeAsync(ms)
  return promise
}

/** Lets a MutationObserver's queued microtask callback run. Fake timers
 * (vi.useFakeTimers()) only intercept macrotask scheduling
 * (setTimeout/rAF), not the microtask queue observers use. */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}
