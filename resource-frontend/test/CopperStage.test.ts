import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopperViewPoint } from '../src/composables/copper-types'
import type { Modality, ModalityId } from '../src/content/types'
import { useCameraChoreography } from '../src/composables/useCameraChoreography'
import { useCopperStage } from '../src/composables/useCopperStage'
import { useModalityScene } from '../src/composables/useModalityScene'
import { useSliceControl } from '../src/composables/useSliceControl'
import { getTourStage } from '../src/composables/useTourStageBridge'
import CopperStage from '../src/components/stage/CopperStage.vue'
import StageControls from '../src/components/stage/StageControls.vue'

/**
 * CopperStage imports its composables directly (they used to be Nuxt
 * auto-imports, resolved through globals). The tests that wrap one still stub
 * the global, so each import is routed through whatever stub a test
 * installed. The depth guard lets a stub call the real composable -- which,
 * imported in this file, is this same wrapper.
 */
const { delegate } = vi.hoisted(() => ({
  delegate<F extends (...args: never[]) => unknown>(name: string, actual: F): F {
    let depth = 0
    return ((...args: Parameters<F>) => {
      const stub = (globalThis as Record<string, unknown>)[name] as F | undefined
      if (depth > 0 || typeof stub !== 'function') return actual(...args)
      depth++
      try { return stub(...args) }
      finally { depth-- }
    }) as F
  },
}))
vi.mock('../src/composables/useCameraChoreography', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composables/useCameraChoreography')>()
  return { ...actual, useCameraChoreography: delegate('useCameraChoreography', actual.useCameraChoreography) }
})
vi.mock('../src/composables/useModalityScene', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composables/useModalityScene')>()
  return { ...actual, useModalityScene: delegate('useModalityScene', actual.useModalityScene) }
})
vi.mock('../src/composables/useCopperStage', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composables/useCopperStage')>()
  return { ...actual, useCopperStage: delegate('useCopperStage', actual.useCopperStage) }
})
vi.mock('../src/composables/useSliceControl', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/composables/useSliceControl')>()
  return { ...actual, useSliceControl: delegate('useSliceControl', actual.useSliceControl) }
})

/**
 * Stands in for `scene.loadGltf(url, onLoad, opts)`. Module-level so a test
 * can queue behaviour before the scene it will land on exists.
 */
const gltfLoad = vi.fn<(url: string, onLoad: (group: any) => void, opts?: any) => void>()

/**
 * The navigation choreography (controller corrections C5 and C6) is the one
 * part of Task 10 that only exists as wiring, so it is tested by mounting
 * the real component against a mocked copper3d -- the same approach
 * useCopperStage.test.ts already established.
 *
 * `prefers-reduced-motion: reduce` is forced on by default here. That is not
 * a convenience: it makes every animation resolve in a single synchronous
 * frame, so most of these tests can assert on ORDER and on WHICH transition
 * ran rather than on a hand-driven clock (useCameraChoreography.test.ts owns
 * the per-frame behaviour). It also exercises design doc §7's own
 * reduced-motion rule, under which the cross-dissolve becomes a direct
 * switch.
 *
 * The last test turns it back OFF and drives the clock by hand, because the
 * crossfade's interrupt path only exists when there are frames to interrupt
 * (fix round 1: that path was previously asserted nowhere).
 *
 * What is still not covered here and needs a browser: that the crossfade
 * looks like tissue filling in rather than two models blinking, and that the
 * flight's arc reads as one camera swinging across.
 */

const VIEWPOINT: CopperViewPoint = {
  farPlane: 1000,
  nearPlane: 0.01,
  eyePosition: [0, 0, 40],
  targetPosition: [1, 2, 3],
  upVector: [0, 1, 0],
}

function makeVec3(x = 0, y = 0, z = 0) {
  const self = {
    x,
    y,
    z,
    set: (nx: number, ny: number, nz: number) => { self.x = nx; self.y = ny; self.z = nz },
  }
  return self
}

/** A GLB group shaped like the real anatomy model. One mesh, whose material
 * is a stable object so the crossfade's opacity can be read back mid-fade. */
function makeGroup() {
  const material = { dispose: vi.fn(), transparent: false, opacity: 1, depthWrite: true, color: { set: vi.fn() } }
  const child = { isMesh: true, name: 'VH_F_gland_L', geometry: { dispose: vi.fn() }, material }
  return {
    name: '',
    material,
    traverse: (fn: (c: typeof child) => void) => { fn(child) },
  }
}

/** An NRRD slice plane this app never displays, which `loadImaging` frees on
 *  the spot. */
function unusedSlicePlane() {
  const mesh = {
    name: '',
    isMesh: true,
    geometry: { dispose: vi.fn() },
    material: { dispose: vi.fn(), map: { dispose: vi.fn() } },
    traverse(fn: (child: unknown) => void) { fn(mesh) },
  }
  return mesh
}

function materialOpacityOf(object: { name: string }): number {
  return (object as unknown as { material: { opacity: number } }).material.opacity
}

function makeScene() {
  const objects: Array<{ name: string }> = []
  const add = vi.fn((obj: { name: string }) => { objects.push(obj) })
  const scene = {
    camera: {
      fov: 45,
      position: makeVec3(0, 0, 100),
      up: makeVec3(0, 1, 0),
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
    },
    // `Copper3dTrackballControls`, which is what
    // `createScene(name, { controls: 'copper3d' })` builds.
    controls: {
      rotateSpeed: 0,
      panSpeed: 0,
      noRotate: false,
      noPan: false,
      staticMoving: false,
      updateOnInput: true,
      enabled: true,
      target: makeVec3(0, 0, 0),
      handleResize: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispose: vi.fn(),
    },
    renderer: { domElement: document.createElement('canvas') },
    requestRenderIfNotRequested: vi.fn(),
    scene: {
      add,
      remove: vi.fn((obj: { name: string }) => { objects.splice(objects.indexOf(obj), 1) }),
      getObjectByName: vi.fn((name: string) => objects.find(o => o.name === name)),
    },
    objects,
    addObject: vi.fn(),
    // Default happy path: resolves synchronously with a plausible 100-slice
    // stack, so a test that only cares about "an imaging modality finished
    // loading" (e.g. the load-gate and control-bar tests below) doesn't have
    // to hand-roll copper3d's loadNrrd callback shape itself. Tests that need
    // to hold the load open, or shape its result differently, override this
    // with their own `mockImplementation` (see e.g. the "does not fly until
    // ..." test below) -- that call fully replaces this one.
    loadNrrd: vi.fn((...args: unknown[]) => {
      const callback = args[2] as (volume: unknown, meshes: unknown, slices: unknown) => void
      callback(
        { RASDimensions: [1, 1, 1], windowHigh: 1, repaintAllSlices: vi.fn() },
        // Only `z`, matching the `axes: ['z']` the app asks for.
        { z: { name: 'z' } },
        { z: { index: 0, MaxIndex: 100, volume: { spacing: [1, 1, 1] }, repaint: vi.fn() } },
      )
    }),
    // copper3d's own `loadGltf` adds the group to the scene itself, so this
    // does too -- `loadGlb` (useModalityScene.ts) adds nothing.
    loadGltf: vi.fn((url: string, onLoad: (g: any) => void, opts?: unknown) =>
      gltfLoad(url, (group) => { add(group); onLoad(group) }, opts)),
    loadView: vi.fn(),
    onWindowResize: vi.fn(),
    confirmResize: vi.fn(),
    pickSpecifiedModel: vi.fn(() => ({ intersectedObject: null })),
  }
  return scene
}

type FakeScene = ReturnType<typeof makeScene>

const scenes = new Map<string, FakeScene>()
const renderer = {
  sceneMap: {} as Record<string, unknown>,
  getSceneByName: vi.fn((name: string) => scenes.get(name)),
  createScene: vi.fn((name: string, _opt?: unknown) => {
    const scene = makeScene()
    scenes.set(name, scene)
    renderer.sceneMap[name] = scene
    return scene
  }),
  setCurrentScene: vi.fn(),
  getCurrentScene: vi.fn(() => ({ onWindowResize: vi.fn() })),
  render: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
}

const copperRendererOnDemond = vi.fn().mockImplementation(function () {
  return renderer
})

/**
 * Mocks the app's OWN seam, not the package. `copper3dModule` is what
 * `useCopperStage` imports from, and it is also what `copperExtras` reads the
 * real library out of -- replacing only `loadCopper3d` swaps the renderer and
 * the controls while leaving copper3d's actual `fitView`, `disposeObject3D`,
 * crossfade and budget functions in place, which is exactly what these tests
 * want to exercise.
 */
vi.mock('../src/composables/copper3dModule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/composables/copper3dModule')>()),
  loadCopper3d: vi.fn(async () => fakeCopper),
}))

const fakeCopper = {
  copperRendererOnDemond,
  loading: () => ({
    loadingContainer: document.createElement('div'),
    progress: document.createElement('div'),
  }),
  // Returns a plain object, so `new Copper3dTrackballControls(...)` yields it
  // (a constructor returning an object overrides `this`). Shaped as the
  // trackball, which is what production reads back off `scene.controls`.
  // A `function`, not an arrow: this is called with `new`.
  Copper3dTrackballControls: vi.fn(function () { return ({
    rotateSpeed: 1,
    panSpeed: 0.3,
    noRotate: false,
    noPan: false,
    staticMoving: false,
    enabled: true,
    target: makeVec3(0, 0, 0),
    handleResize: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispose: vi.fn(),
  }) }),
  addBoxHelper: vi.fn(),
}

/** The callbacks live `ResizeObserver` instances were constructed with,
 *  newest last. `useCopperStage` creates exactly one per stage. */
const resizeCallbacks: ResizeObserverCallback[] = []

const ANATOMY_PRESET = 'left_breast_view.json'

function modality(id: ModalityId, asset: string): Modality {
  return {
    id,
    label: id,
    asset,
    viewPreset: id === 'anatomy' ? ANATOMY_PRESET : 'x/view.json',
    text: '',
    keyFacts: [],
  }
}

const DENSITY_A = modality('anatomy', 'density-1/left/density25.glb')
const DENSITY_B = modality('anatomy', 'density-2/left/density50.glb')
const DENSITY_C = modality('anatomy', 'density-3/left/density75.glb')
const MRI = modality('mri', 'density-1/right/mri.nrrd')

/**
 * Mounts the stage and gives its host a measured box, `getBoundingClientRect`-
 * style, defaulting to a plainly non-zero one -- otherwise every pre-existing
 * test in this file measures 0x0 and the load gate (below) keeps them from
 * ever loading at all.
 *
 * The box can't be applied by simply stubbing `getBoundingClientRect` alone:
 * `useCopperStage`'s `ResizeObserver` only exists once copper3d's dynamic
 * import resolves, deep inside `onMounted`, so there is nothing to drive yet
 * at the point this function returns. The fire below is queued rather than
 * awaited (this function is synchronous, matching plain `mount()`) -- every
 * call site immediately follows with its own `await flushPromises()` (or
 * `settle()`), which is what actually lets it land before any assertion.
 */
function mountStage(overrides: Record<string, unknown> = {}) {
  const { hostSize = { width: 400, height: 300 }, ...props } = overrides as {
    hostSize?: { width: number, height: number }
  } & Record<string, unknown>

  const wrapper = mount(CopperStage, {
    props: {
      slug: 'density-a', group: 'density', lesionSliceIndex: 0, modality: DENSITY_A,
      panelLabel: 'Anatomy', panelId: 'anatomy', ...props,
    },
    // Nuxt auto-imports components; plain Vitest does not, so the
    // `<StageControls>` in this component's template would resolve to
    // nothing and render as an unknown element. Registering it here is what
    // lets the "the control bar is the stage's own" block assert on the real
    // component rather than on a stub of it.
    global: { components: { StageControls } },
    attachTo: document.body,
  })

  const host = wrapper.get('[role="application"]').element as HTMLElement
  host.getBoundingClientRect = () => ({
    ...hostSize, top: 0, left: 0, right: hostSize.width, bottom: hostSize.height, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect

  void flushPromises().then(() => {
    for (const callback of resizeCallbacks) {
      callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
    }
  })

  return wrapper
}

/**
 * Drives the stage's ResizeObserver with a new box.
 *
 * `useCopperStage`'s observer reads the size back off the host with
 * `getBoundingClientRect()` rather than from the entry, so that is what
 * has to be stubbed -- the entry is only the trigger.
 */
async function resizeHost(
  wrapper: ReturnType<typeof mountStage>,
  box: { width: number, height: number },
) {
  const host = wrapper.get('[role="application"]').element as HTMLElement
  host.getBoundingClientRect = () => ({
    ...box, top: 0, left: 0, right: box.width, bottom: box.height, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect
  for (const callback of resizeCallbacks) {
    callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
  }
  await flushPromises()
}

/** Lets every awaited load / animation in `enterView` settle. */
async function settle() {
  for (let i = 0; i < 8; i++) await flushPromises()
}

describe('CopperStage navigation choreography', () => {
  beforeEach(() => {
    scenes.clear()
    renderer.sceneMap = {}
    vi.clearAllMocks()

    resizeCallbacks.length = 0
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
      observe() {}
      disconnect() {}
    })
    // Mirrors how production resolves this Nuxt-auto-imported composable --
    // see this file's header. Every test here mounts an anatomy modality by
    // default (DENSITY_A), so a default implementation resolving with a
    // fresh group keeps every test that doesn't care about GLB timing
    // working without its own setup; tests that DO care override a specific
    // call with `mockImplementationOnce`/`mockResolvedValueOnce`.
    gltfLoad.mockReset()
    gltfLoad.mockImplementation((_url, onLoad) => { onLoad(makeGroup()) })
    vi.stubGlobal('useCopperStage', useCopperStage)
    vi.stubGlobal('useModalityScene', useModalityScene)
    vi.stubGlobal('useCameraChoreography', useCameraChoreography)
    vi.stubGlobal('useSliceControl', useSliceControl)
    vi.stubGlobal('matchMedia', () => ({
      matches: true, // see this file's header
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(VIEWPOINT),
    })))
  })

  it('loads the scene for its own case and modality on mount', async () => {
    mountStage({})
    await settle()

    expect(renderer.createScene).toHaveBeenCalledWith('/modelView/density-1/left/density25.glb', { controls: 'copper3d' })
    expect(gltfLoad).toHaveBeenCalledTimes(1)
    expect(gltfLoad.mock.calls[0]![0]).toBe('/modelView/density-1/left/density25.glb')
    // The new guarantee this app now owns instead of copper3d: without this
    // call the model would decode perfectly and simply never appear.
    expect(scenes.get('/modelView/density-1/left/density25.glb')!.scene.add).toHaveBeenCalledTimes(1)
  })

  /**
   * Controller correction C5, and the reason it exists: an earlier draft of
   * this task added a SECOND watcher to pick the transition while leaving
   * the original one loading unconditionally. The density branch would have
   * returned early, the other watcher would have called `load()` anyway, and
   * §7.1 -- this task's headline feature -- would have crossfaded inside a
   * scene being replaced out from under it. One watcher decides, and the
   * density branch suppresses the load entirely.
   */
  it('crossfades within the existing scene on a density step, without loading a second scene', async () => {
    const wrapper = mountStage({})
    await settle()
    const scene = scenes.get('/modelView/density-1/left/density25.glb')!
    expect(scene.objects).toHaveLength(1)

    await wrapper.setProps({ slug: 'density-b', modality: DENSITY_B })
    await settle()

    // No new scene, and the renderer was never switched to one.
    expect(renderer.createScene).toHaveBeenCalledTimes(1)
    expect(scenes.size).toBe(1)
    // The incoming model was loaded into the SAME scene and the outgoing one
    // removed once the crossfade committed.
    expect(gltfLoad).toHaveBeenCalledTimes(2)
    expect(gltfLoad.mock.calls[1]![0]).toBe('/modelView/density-2/left/density50.glb')
    // Adding the incoming model to the scene is this app's own job now, not
    // copper3d's -- once for the initial load, once for the morph.
    expect(scene.scene.add).toHaveBeenCalledTimes(2)
    expect(scene.scene.remove).toHaveBeenCalledTimes(1)
    expect(scene.objects).toHaveLength(1)
    expect(scene.objects[0]!.name).toBe('anatomy-model')
  })

  // §7.1: "the camera does not move at all". The crossfade must not write
  // the camera, and it must not re-apply a view preset either.
  it('leaves the camera exactly where it was through a density crossfade', async () => {
    const wrapper = mountStage({})
    await settle()
    const scene = scenes.get('/modelView/density-1/left/density25.glb')!
    scene.camera.position.set(5, 6, 7)
    scene.loadView.mockClear()

    await wrapper.setProps({ slug: 'density-b', modality: DENSITY_B })
    await settle()

    expect(scene.camera.position.x).toBe(5)
    expect(scene.camera.position.y).toBe(6)
    expect(scene.camera.position.z).toBe(7)
    expect(scene.loadView).not.toHaveBeenCalled()
  })

  /**
   * Controller correction C6. `await nextTick()` (the earlier draft) only
   * flushes Vue's render queue: it returns long before a GLB, let alone a
   * 53MB NRRD, has arrived, so the flight would read its destination off a
   * camera that is either still the outgoing scene's or the incoming
   * scene's unframed default. Driving off actual load completion means the
   * camera must not have been written while the load was still in flight.
   */
  it('does not fly until the incoming modality has actually finished loading', async () => {
    const wrapper = mountStage({})
    await settle()

    // Hold the NRRD load open, as a slow network would.
    let finishLoad!: () => void
    const mriScene = makeScene()
    renderer.createScene.mockImplementationOnce((name: string) => {
      scenes.set(name, mriScene)
      return mriScene
    })
    mriScene.loadNrrd.mockImplementation((...args: unknown[]) => {
      const callback = args[2] as (v: unknown, m: unknown, s: unknown) => void
      finishLoad = () => callback(
        { RASDimensions: [1, 1, 1], windowHigh: 1, repaintAllSlices: vi.fn() },
        // `traverse` because the unused x/y planes are freed by
        // `disposeObject3D`, which walks them the same way it walks a
        // subtree -- a real THREE.Mesh has it.
        { x: unusedSlicePlane(), y: unusedSlicePlane(), z: { name: 'z' } },
        { z: { index: 0, MaxIndex: 100, volume: { spacing: [1, 1, 1] }, repaint: vi.fn() } },
      )
    })

    await wrapper.setProps({ modality: MRI })
    await settle()

    // Mid-load: the incoming scene has not been framed yet. `loadView` is
    // what frames it, and it must not have run on a scene with no content.
    expect(mriScene.loadView).not.toHaveBeenCalled()

    finishLoad()
    await settle()

    // The switch is a hard CUT now -- §7.3's inter-modality camera flight
    // was deleted at the human's instruction, so this no longer checks a
    // camera arc. What it still guarantees is the ordering the flight test
    // was really built around: the modality's own view preset is applied
    // only once its content has actually arrived. `loadView` writes the
    // camera AND `controls.target` together (Scene/baseScene.js:88-98),
    // which is the sync correction C7 called load-bearing.
    expect(mriScene.loadView).toHaveBeenCalledTimes(1)
    expect(mriScene.loadView).toHaveBeenCalledWith(
      expect.objectContaining({ targetPosition: [1, 2, 3] }),
    )
  })

  /**
   * `the-breast` and `density-a` ship the SAME `density25.glb`, so there is
   * nothing to crossfade between them (controller correction C12: the morph
   * declines to fade a model against its own twin) -- and, since scenes are
   * keyed by asset rather than by slug, nothing to rebuild either.
   *
   * This used to build a second scene under a second name and decode the
   * same file twice. The human caught it: The Breast and density-A are
   * exactly the same content, so just reuse it -- why render it twice?
   */
  it('reuses the one scene when two cases ship the same asset', async () => {
    const wrapper = mountStage({ slug: 'the-breast', group: 'overview' })
    await settle()

    await wrapper.setProps({ slug: 'density-a', group: 'density', modality: DENSITY_A })
    await settle()

    // One scene, built once, for one file -- not one per case.
    expect(renderer.createScene).toHaveBeenCalledTimes(1)
    expect(renderer.createScene).toHaveBeenCalledWith('/modelView/density-1/left/density25.glb', { controls: 'copper3d' })
    // And the model in it is left alone: no teardown, no second download.
    expect(scenes.get('/modelView/density-1/left/density25.glb')!.scene.remove).not.toHaveBeenCalled()
    expect(gltfLoad).toHaveBeenCalledTimes(1)
  })

  /**
   * Fix round 1, Important. `prepareMorph` awaits a ~1.28MB GLB, and the
   * user can step to a third density inside that window. Before the fix the
   * superseded morph came back and called `camera.animate`, whose
   * unconditional `interrupt()` (useCameraChoreography.ts) cancels whatever
   * the NEWER navigation started -- its entrance orbit, mid-swing -- and
   * then ran an 800ms crossfade in a scene that was no longer on screen.
   */
  it('does not animate a crossfade that a newer navigation has already superseded', async () => {
    const animate = vi.fn()
    vi.stubGlobal('useCameraChoreography', (...args: Parameters<typeof useCameraChoreography>) => {
      const api = useCameraChoreography(...args)
      animate.mockImplementation(api.animate)
      return { ...api, animate }
    })

    const wrapper = mountStage({})
    await settle()
    const first = scenes.get('/modelView/density-1/left/density25.glb')!

    // Hold density-b's GLB open, as a slow network would.
    let landB!: () => void
    gltfLoad.mockImplementationOnce((_url, onLoad) => { landB = () => onLoad(makeGroup()) })
    await wrapper.setProps({ slug: 'density-b', modality: DENSITY_B })
    await settle()
    animate.mockClear()

    // The user steps on to density-c before density-b's model arrives.
    await wrapper.setProps({ slug: 'density-c', modality: DENSITY_C })
    await settle()
    const animateCallsForNavTwo = animate.mock.calls.length

    landB()
    await settle()

    // The superseded morph settled its own scene without ever reaching the
    // driver -- no interrupt, no 800ms crossfade off screen.
    expect(animate.mock.calls.length).toBe(animateCallsForNavTwo)
    // ...and it left exactly one model behind, not two stacked.
    expect(first.objects).toHaveLength(1)
    expect(first.objects[0]!.name).toBe('anatomy-model')
  })

  /**
   * Fix round 1, test hole. Every other test in this file forces reduced
   * motion, which makes `animate` resolve in one synchronous frame -- good
   * for asserting ordering, but it means the crossfade's interrupt path was
   * never driven. That path is a deliberate design decision (a drag during
   * a morph COMPLETES the swap instead of freezing two half-transparent
   * models, because unlike a camera pose there is no valid resting state
   * between the two ends), and it was asserted nowhere.
   */
  it('an interrupted crossfade still settles on one fully-opaque model', async () => {
    // Reduced motion OFF, and a hand-driven clock so the morph can be
    // caught mid-fade.
    let queued: FrameRequestCallback | null = null
    let now = 0
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queued = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => { queued = null })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const advance = (ms: number) => {
      now += ms
      const cb = queued
      queued = null
      cb?.(now)
    }

    const wrapper = mountStage({})
    await settle()
    const scene = scenes.get('/modelView/density-1/left/density25.glb')!
    const outgoing = scene.objects[0]!

    await wrapper.setProps({ slug: 'density-b', modality: DENSITY_B })
    await settle()

    advance(200) // 200ms into an 800ms crossfade: both models part-faded
    const opacities = scene.objects.map(o => materialOpacityOf(o))
    expect(opacities.some(value => value > 0 && value < 1)).toBe(true)

    // Any user input hands control back (§7.4) -- and here that has to mean
    // "finish the swap now", not "leave it half-done forever".
    const camera = (wrapper.vm as unknown as { camera: { interrupt: () => void } }).camera
    camera.interrupt()
    await settle()

    expect(scene.objects).toHaveLength(1)
    expect(scene.objects[0]).not.toBe(outgoing)
    expect(materialOpacityOf(scene.objects[0]!)).toBe(1)
  })

  // Review fix (Task 3, three-up plan): `onUserInput` (pointerdown/wheel)
  // was the only place that marked a scene posed, so a keyboard-only
  // reader -- who has no other way to move the camera at all -- could
  // never pose it, and the next panel resize silently discarded their
  // orbit/zoom. `onStageKeydown` must mark posed too, for every key that
  // actually moves the camera.
  it('marks the scene posed on a keyboard orbit, the only way a keyboard-only reader can move the camera', async () => {
    const markPosed = vi.fn()
    vi.stubGlobal('useModalityScene', (...args: Parameters<typeof useModalityScene>) => {
      const api = useModalityScene(...args)
      markPosed.mockImplementation(api.markPosed)
      return { ...api, markPosed }
    })

    const wrapper = mountStage({ modality: MRI })
    await settle()
    expect(markPosed).not.toHaveBeenCalled()

    await wrapper.find('[role="application"]').trigger('keydown', { key: 'ArrowLeft' })

    expect(markPosed).toHaveBeenCalledWith(true)
  })

  // Same fix, the zoom keys: a separate switch branch from the arrow keys,
  // so it needs its own proof rather than trusting the arrow-key case above
  // to cover it.
  it('marks the scene posed on a keyboard zoom too', async () => {
    const markPosed = vi.fn()
    vi.stubGlobal('useModalityScene', (...args: Parameters<typeof useModalityScene>) => {
      const api = useModalityScene(...args)
      markPosed.mockImplementation(api.markPosed)
      return { ...api, markPosed }
    })

    const wrapper = mountStage({ modality: MRI })
    await settle()

    await wrapper.find('[role="application"]').trigger('keydown', { key: '+' })

    expect(markPosed).toHaveBeenCalledWith(true)
  })
})

describe('load gate: nothing downloads until CSS has given this panel a box', () => {
  let loadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    loadSpy = vi.fn()
    vi.stubGlobal('useModalityScene', (...args: Parameters<typeof useModalityScene>) => {
      const api = useModalityScene(...args)
      loadSpy.mockImplementation(api.load)
      return { ...api, load: loadSpy }
    })
  })

  /**
   * Three stages are mounted at all times (client feedback item 5 -- an
   * unmounted stage is a destroyed renderer). One-up hides two of them
   * with `display: none`, which measures 0x0, and that measurement is the
   * only signal here about which tier the layout is in. No breakpoint
   * literal in JS: the host's size IS what CSS decided.
   */
  it('does not call load() while the host measures zero', async () => {
    mountStage({ hostSize: { width: 0, height: 0 } })
    await flushPromises()
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('loads as soon as the host is given a size', async () => {
    const wrapper = mountStage({ hostSize: { width: 0, height: 0 } })
    await flushPromises()
    expect(loadSpy).not.toHaveBeenCalled()

    await resizeHost(wrapper, { width: 400, height: 300 })
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it('stays loaded when the host is hidden again', async () => {
    const wrapper = mountStage({ hostSize: { width: 400, height: 300 } })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledTimes(1)

    await resizeHost(wrapper, { width: 0, height: 0 })
    await resizeHost(wrapper, { width: 400, height: 300 })
    // Re-shown, not re-downloaded: the scene is cached and load() short-
    // circuits on it, but it must not be called again from the gate.
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it('does not load while loadEnabled is false, and loads once it flips true', async () => {
    const wrapper = mountStage({ loadEnabled: false })
    await flushPromises()
    expect(loadSpy).not.toHaveBeenCalled()

    await wrapper.setProps({ loadEnabled: true })
    await settle()
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it('emits settled once the load resolves', async () => {
    const wrapper = mountStage({ loadEnabled: true })
    await settle()
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('emits settled even when the load rejects, so siblings are never blocked', async () => {
    loadSpy.mockImplementation(() => Promise.reject(new Error('network')))
    const wrapper = mountStage({ loadEnabled: true })
    await settle()
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('defaults to enabled, so any caller that does not stage behaves as before', async () => {
    mountStage({})
    await settle()
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })
})

describe('the control bar is the stage\'s own', () => {
  it('renders one StageControls inside the stage', async () => {
    const wrapper = mountStage({ hostSize: { width: 400, height: 300 } })
    await flushPromises()
    expect(wrapper.findAllComponents(StageControls)).toHaveLength(1)
  })

  // StageControls' own gate (StageControls.test.ts) is "lesionSliceIndex > 0
  // AND sliceMax > 0" -- anatomy structurally never has slices (it is a
  // GLB), so this needs an imaging modality to exercise the positive case at
  // all; the default `loadNrrd` above resolves synchronously with a 100-
  // slice stack for exactly this.
  /**
   * Asserted on the prop the stage forwards, not on the rendered button.
   *
   * `StageControls` only offers "Locate lesion" when it has BOTH a lesion
   * index and a slice stack to move through, and the second of those only
   * arrives once a real volume has decoded -- which needs WebGL, so it
   * cannot happen here. `StageControls.test.ts` covers that gating against
   * both inputs directly; what belongs to this component is that it hands
   * its own bar the index it was given.
   */
  it('forwards its lesion index to the bar it owns', async () => {
    const withLesion = mountStage({ modality: MRI, lesionSliceIndex: 90, hostSize: { width: 400, height: 300 } })
    await flushPromises()
    expect(withLesion.findComponent(StageControls).props('lesionSliceIndex')).toBe(90)

    const without = mountStage({ modality: MRI, lesionSliceIndex: 0, hostSize: { width: 400, height: 300 } })
    await flushPromises()
    expect(without.findComponent(StageControls).props('lesionSliceIndex')).toBe(0)
    expect(without.text()).not.toContain('Locate lesion')
  })
})

describe('tour bridge registration', () => {
  it('registers its capabilities under its own panel id, and drops them on unmount', async () => {
    const wrapper = mountStage({ panelId: 'mri' })
    await settle()
    expect(getTourStage('mri')).toBeDefined()
    wrapper.unmount()
    expect(getTourStage('mri')).toBeUndefined()
  })

  it('reports the lesion slice its props carry, so the director need not know the content model', async () => {
    const wrapper = mountStage({ panelId: 'mri', modality: MRI, lesionSliceIndex: 62 })
    await settle()
    expect(getTourStage('mri')!.lesionSliceIndex()).toBe(62)
    wrapper.unmount()
  })
})
