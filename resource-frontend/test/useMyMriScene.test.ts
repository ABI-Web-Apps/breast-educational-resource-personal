import { flushPromises, mount } from '@vue/test-utils'
import { OrientationError } from 'copper3d'
import type { VolumeGeometry } from 'copper3d'
import {
  Box3, BoxGeometry, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PerspectiveCamera, Scene, Texture, Vector3,
} from 'three'
import type { Matrix4 } from 'three'
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindingSummary } from '../src/myMri/useMyMriSession'
import { worldFromLps } from '../src/myMri/patientFrame'
import { useMyMriScene } from '../src/myMri/useMyMriScene'
import type { MyMriSources } from '../src/myMri/useMyMriScene'

/**
 * copper3d is faked through the app's own seam (`copper3dModule`), as in
 * `useCopperStage.test.ts`: no WebGL, no NRRD/GLB decoding. The scene, camera,
 * planes and mask are real three objects, so placement, framing and disposal
 * run against the genuine math and the genuine `dispose` methods.
 */

const budget = {
  register: vi.fn(), touch: vi.fn(), pin: vi.fn(), unpin: vi.fn(), release: vi.fn(),
  rename: vi.fn(), overflow: vi.fn(() => []), bytes: vi.fn(() => 0),
}
vi.mock('../src/composables/sceneBudget', () => ({ getSceneBudget: () => budget }))

function makeControls() {
  return {
    rotateSpeed: 1, panSpeed: 0.3, noRotate: false, noPan: false, staticMoving: false,
    updateOnInput: true, enabled: true, target: new Vector3(), rotationPivot: null as Vector3 | null,
    minDistance: 0, maxDistance: Infinity,
    handleResize: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispose: vi.fn(),
  }
}

/** A `copperSceneOnDemond` double: what `createScene(name, { controls: 'copper3d' })` returns. */
function makeScene() {
  const three = new Scene()
  // copper3d's one light that is actually in the scene graph (the rest hang off the camera).
  const hemi = new HemisphereLight()
  hemi.name = 'hemi_light'
  three.add(hemi)
  return {
    camera: new PerspectiveCamera(45, 1, 0.1, 1000),
    controls: makeControls(),
    scene: three,
    sceneName: '',
    cameraPositionFlag: false,
    requestRenderIfNotRequested: vi.fn(),
    confirmResize: vi.fn(),
    onWindowResize: vi.fn(),
    dispose: vi.fn(),
    addObject: vi.fn((obj: any) => { three.add(obj) }),
    loadNrrd: vi.fn(),
    loadGltf: vi.fn(),
  }
}
type FakeScene = ReturnType<typeof makeScene>

function makeRenderer(scene: FakeScene) {
  const sceneMap: Record<string, FakeScene> = {}
  return {
    sceneMap,
    getSceneByName: vi.fn((name: string) => sceneMap[name]),
    createScene: vi.fn((name: string, _opt?: unknown) => {
      sceneMap[name] = scene
      scene.sceneName = name
      return scene
    }),
    setCurrentScene: vi.fn(),
    getCurrentScene: vi.fn(() => scene),
    render: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  }
}

let scene: FakeScene
let renderer: ReturnType<typeof makeRenderer>

// A regular function: it is invoked with `new`.
const copperRendererOnDemond = vi.fn().mockImplementation(function () { return renderer })

vi.mock('../src/composables/copper3dModule', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/composables/copper3dModule')>()),
  loadCopper3d: vi.fn(async () => ({
    copperRendererOnDemond,
    loading: () => ({ loadingContainer: document.createElement('div'), progress: document.createElement('div') }),
  })),
}))

class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}
beforeAll(() => { vi.stubGlobal('ResizeObserver', FakeResizeObserver) })
afterAll(() => { vi.unstubAllGlobals() })

/** sub-1's registration_1 grid. */
const GEOMETRY: VolumeGeometry = {
  dims: [384, 384, 104],
  directions: [[0.885, 0, 0], [0, 0.885, 0], [0, 0, 1.5]],
  origin: [-175.54, -159.94, -84.44],
}
/** copper3d's `RASDimensions` for that grid: `(n - 1) * spacing + 1`. */
const RAS = [383 * 0.885 + 1, 383 * 0.885 + 1, 103 * 1.5 + 1]

const MRI = '/api/patients/a-1/sub-1/mri'
const MASK = '/api/patients/a-1/sub-1/mask.glb'
const FINDINGS: FindingSummary[] = [
  { label: 'Finding 1', channel: 1, color: '#ff7043' },
  { label: 'Finding 2', channel: 2, color: '#42a5f5' },
]

function plane(w: number, h: number, d: number) {
  return new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial({ map: new Texture() }))
}
function makeMeshes() {
  return { x: plane(0, RAS[1]!, RAS[2]!), y: plane(RAS[0]!, 0, RAS[2]!), z: plane(RAS[0]!, RAS[1]!, 0) }
}
function makeVolume(data: ArrayLike<number> = new Int16Array(64), min = 0, max = 1) {
  return {
    RASDimensions: RAS,
    orientation: { geometry: GEOMETRY },
    data,
    min, max, windowLow: min, windowHigh: max,
    repaintAllSlices: vi.fn(),
  }
}

/** three's `FileLoader` rejects a non-2xx with an `HttpError` carrying the `Response`. */
function httpError(status: number, body: unknown) {
  return Object.assign(new Error(`fetch for "${MASK}" responded with ${status}`), {
    response: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  })
}
/** What the backend's `mask.glb` decodes to: one node per label, named `channel_<n>`. */
function makeMask(channels = [1, 2]) {
  const group = new Group()
  for (const n of channels) {
    const mesh = new Mesh(new BoxGeometry(4, 4, 4), new MeshStandardMaterial({ color: '#00ff00', vertexColors: true }))
    mesh.name = `channel_${n}`
    group.add(mesh)
  }
  return group
}

const Host = defineComponent({
  props: { sources: { type: Object, required: true } },
  setup(props) {
    const host = ref<HTMLElement | null>(null)
    const api = useMyMriScene(host, props.sources as MyMriSources)
    return { host, api }
  },
  render() { return h('div', { ref: 'host' }) },
})
type Api = ReturnType<typeof useMyMriScene>

const mounted: { unmount: () => void }[] = []
async function mountScene(findings: FindingSummary[] = FINDINGS) {
  const wrapper = mount(Host, { props: { sources: { mri: MRI, mask: MASK, findings } } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, api: (wrapper.vm as unknown as { api: Api }).api }
}

function nrrdCall() {
  return scene.loadNrrd.mock.calls[0] as unknown as [string, unknown, (...args: any[]) => void, any]
}
function gltfCall() {
  return scene.loadGltf.mock.calls[0] as unknown as [string, (group: Group) => void, any]
}

/**
 * copper3d's slice objects: `index` is in grid millimetres (slice number times
 * `RSARatio`, the spacing), `RSAMaxIndex` is `RASDimensions - 1`.
 */
function makeSlices() {
  const slice = (axis: 0 | 1 | 2) => ({
    index: Math.floor(GEOMETRY.dims[axis] / 2) * Math.hypot(...GEOMETRY.directions[axis]),
    RSAMaxIndex: RAS[axis]! - 1,
    RSARatio: Math.hypot(...GEOMETRY.directions[axis]),
    MaxIndex: GEOMETRY.dims[axis] - 1,
    volume: { spacing: GEOMETRY.directions.map(d => Math.hypot(...d)) },
    repaint: vi.fn(),
  })
  return { x: slice(0), y: slice(1), z: slice(2) }
}

/** Lands the volume the way copper3d's loader hands it over. */
function landVolume(volume = makeVolume(), meshes = makeMeshes(), slices = makeSlices()) {
  nrrdCall()[2](volume, meshes, slices)
  return { volume, meshes, slices }
}

/**
 * Lands the mask the way `copperSceneOnDemond.loadGltf` does: it adds the group
 * to the scene, recentres the group's `position` on its own box and bounds the
 * dolly on the model, all before the callback runs.
 */
function landMask(group = makeMask()) {
  scene.scene.add(group)
  group.position.set(-12, 34, -56)
  scene.controls.maxDistance = 5
  gltfCall()[1](group)
  return group
}

function expectMatrixClose(actual: Matrix4, expected: Matrix4) {
  actual.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i]!, 9))
}

function materialOf(group: Group, name: string) {
  return (group.getObjectByName(name) as Mesh).material as MeshStandardMaterial
}

beforeEach(() => {
  scene = makeScene()
  renderer = makeRenderer(scene)
  copperRendererOnDemond.mockClear()
  Object.values(budget).forEach(fn => fn.mockClear())
})

afterEach(() => {
  mounted.splice(0).forEach(w => w.unmount())
  vi.useRealTimers()
})

describe('useMyMriScene', () => {
  it('adds all three planes and the mask placed in the patient frame', async () => {
    const { api } = await mountScene()
    expect(renderer.createScene).toHaveBeenCalledWith(expect.any(String), { controls: 'copper3d' })
    // Absolute: copper3d fetches the volume inside a `blob:` worker, which
    // cannot resolve the root-relative `/api/...` -- see `absoluteUrl`.
    expect(scene.loadNrrd).toHaveBeenCalledWith(new URL(MRI, document.baseURI).href, expect.anything(),
      expect.any(Function), expect.objectContaining({ axes: ['x', 'y', 'z'] }))
    expect(api.status.value).toBe('loading')

    const { meshes } = landVolume()
    for (const p of [meshes.x, meshes.y, meshes.z]) {
      expect(scene.scene.children).toContain(p)
      expect(p.renderOrder).toBe(1)
      // The planes show the image's own greys, not tone-mapped ones.
      expect((p.material as MeshBasicMaterial).toneMapped).toBe(false)
    }
    expect(scene.loadGltf).toHaveBeenCalledWith(MASK, expect.any(Function), expect.anything())

    const group = landMask()
    expect(group.matrixAutoUpdate).toBe(false)
    // loadGltf's recentring is undone, so nothing can ever read it back.
    expect(group.position.toArray()).toEqual([0, 0, 0])
    // loadGltf's recentring wrote `position`; with the matrix pinned it has no effect.
    scene.scene.updateMatrixWorld(true)
    expectMatrixClose(group.matrixWorld, worldFromLps(GEOMETRY, RAS))
    await nextTick()
    expect(api.status.value).toBe('ready')
  })

  it('moves the three planes through the centre of the marked area', async () => {
    await mountScene()
    const { slices } = landVolume()
    const group = makeMask()
    group.children[0]!.position.set(-60, 20, 10) // mask vertices are in LPS mm
    const placed = landMask(group)
    const centre = new Box3().setFromObject(placed).getCenter(new Vector3())
    // Plane `index` sits at `index - RSAMaxIndex / 2` in the world (the validator's
    // `resetSliceIndex`), so this puts each plane through the centre.
    expect(slices.x.index).toBeCloseTo(slices.x.RSAMaxIndex / 2 + centre.x, 9)
    expect(slices.y.index).toBeCloseTo(slices.y.RSAMaxIndex / 2 + centre.y, 9)
    expect(slices.z.index).toBeCloseTo(slices.z.RSAMaxIndex / 2 + centre.z, 9)
    for (const s of [slices.x, slices.y, slices.z]) {
      expect(s.repaint).toHaveBeenCalled()
      expect(s.repaint.mock.contexts.at(-1)).toBe(s)
    }
  })

  it('colours each channel from its finding', async () => {
    await mountScene()
    landVolume()
    const group = landMask()
    const original = makeMask().children[0] as Mesh
    for (const [name, hex] of [['channel_1', 'ff7043'], ['channel_2', '42a5f5']] as const) {
      const material = materialOf(group, name)
      expect(material.color.getHexString()).toBe(hex)
      expect(material.opacity).toBe(0.5)
      expect(material.transparent).toBe(true)
      expect(material.depthWrite).toBe(false)
      // The GLB's own per-vertex colours would multiply the finding colour.
      expect(material.vertexColors).toBe(false)
      expect(group.getObjectByName(name)!.renderOrder).toBe(4)
      expect(material).not.toBe(original.material)
    }
  })

  it('falls back to the neutral colour without findings', async () => {
    await mountScene([])
    landVolume()
    const group = landMask()
    expect(materialOf(group, 'channel_1').color.getHexString()).toBe('94a3b8')
    expect(materialOf(group, 'channel_2').color.getHexString()).toBe('94a3b8')
  })

  it('uses the neutral colour for a channel no finding names, or a colour that is not #rrggbb', async () => {
    await mountScene([{ label: 'Finding 1', channel: 1, color: 'not-a-colour' }])
    landVolume()
    const group = landMask(makeMask([1, 3]))
    expect(materialOf(group, 'channel_1').color.getHexString()).toBe('94a3b8')
    expect(materialOf(group, 'channel_3').color.getHexString()).toBe('94a3b8')
  })

  it('frees the GLB\'s own materials once replaced', async () => {
    await mountScene()
    landVolume()
    const group = makeMask()
    const own = (group.children[0] as Mesh).material as MeshStandardMaterial
    const freed = vi.spyOn(own, 'dispose')
    landMask(group)
    expect(freed).toHaveBeenCalled()
  })

  it('reports a load error instead of a blank stage', async () => {
    const { api } = await mountScene()
    nrrdCall()[3].onError(new OrientationError('no_space', 'The header has no space field'))
    await nextTick()
    expect(api.status.value).toBe('error')
    expect(api.error.value).toMatch(/orientation/i)
    expect(scene.loadGltf).not.toHaveBeenCalled()
  })

  it('reports a mask that fails to load', async () => {
    const { api } = await mountScene()
    landVolume()
    gltfCall()[2].onError(new Error('HTTP 422'))
    await nextTick()
    expect(api.status.value).toBe('error')
    expect(api.error.value).toBeTruthy()
  })

  it('reports a renderer that cannot be built', async () => {
    copperRendererOnDemond.mockImplementationOnce(function () { throw new Error('WebGL unavailable') })
    const { api } = await mountScene()
    expect(api.status.value).toBe('error')
    expect(api.error.value).toBeTruthy()
  })

  it('reports a download that stops making progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { api } = await mountScene()
    vi.advanceTimersByTime(10_000)
    nrrdCall()[3].onProgress({ loaded: 1, total: 2 })
    vi.advanceTimersByTime(10_000)
    expect(api.status.value).toBe('loading')
    vi.advanceTimersByTime(10_000)
    expect(api.status.value).toBe('error')
    expect(nrrdCall()[3].signal.aborted).toBe(true)
  })

  it('frames the camera on the planes, and Reset restores that framing', async () => {
    const { api } = await mountScene()
    // loadGltf would otherwise frame the camera on the mask it loads.
    expect(scene.cameraPositionFlag).toBe(true)
    landVolume()
    landMask()
    // loadGltf bounded the dolly on the (small) mask; the limit comes from the planes again.
    expect(scene.controls.maxDistance).toBeGreaterThan(1000)
    const eye = scene.camera.position.clone()
    const target = scene.controls.target.clone()
    // The validator's opening view: from inferior (-z), anterior (-y) up.
    expect(eye.z).toBeLessThan(target.z)
    expect(scene.camera.up.y).toBeCloseTo(-1, 9)
    expect(scene.controls.rotationPivot).not.toBeNull()

    scene.camera.position.set(1, 2, 3)
    scene.controls.target.set(9, 9, 9)
    renderer.render.mockClear()
    api.resetView()
    expect(scene.camera.position.distanceTo(eye)).toBeCloseTo(0, 9)
    expect(scene.controls.target.distanceTo(target)).toBeCloseTo(0, 9)
    expect(renderer.render).toHaveBeenCalled()
  })

  it('frames the first volume even when the reader touched the stage while it loaded', async () => {
    const { wrapper, api } = await mountScene()
    wrapper.element.dispatchEvent(new Event('pointerdown'))
    wrapper.element.dispatchEvent(new Event('wheel'))
    landVolume()
    const eye = scene.camera.position.clone()
    expect(scene.camera.far).toBeGreaterThanOrEqual(scene.controls.maxDistance)
    api.resetView()
    expect(scene.camera.position.distanceTo(eye)).toBeCloseTo(0, 9)
  })

  it('keeps the far plane past the dolly limit once the mask has landed', async () => {
    await mountScene()
    landVolume()
    landMask()
    expect(scene.camera.far).toBeGreaterThanOrEqual(scene.controls.maxDistance)
  })

  it('windows the planes on the 1st to 99th percentile of the volume', async () => {
    await mountScene()
    const ramp = Float32Array.from({ length: 100_000 }, (_, i) => i / 10) // 0 .. 9999.9, uniform
    const { volume } = landVolume(makeVolume(ramp, 0, 9999.9))
    expect(volume.windowLow).toBeGreaterThan(95)
    expect(volume.windowLow).toBeLessThan(105)
    expect(volume.windowHigh).toBeGreaterThan(9895)
    expect(volume.windowHigh).toBeLessThan(9905)
    expect(volume.repaintAllSlices).toHaveBeenCalled()
  })

  it('leaves a flat volume on its own range', async () => {
    await mountScene()
    const { volume } = landVolume(makeVolume(new Int16Array(64).fill(7), 7, 7))
    expect(volume.windowLow).toBe(7)
    expect(volume.windowHigh).toBe(7)
  })

  it('shows the planes without a mesh when the scan has no mask', async () => {
    const { api } = await mountScene()
    const { slices } = landVolume()
    const before = slices.z.index
    gltfCall()[2].onError(httpError(404, { detail: { code: 'no_mask', summary: 'Cohort sub-1 has no mask.' } }))
    await flushPromises()
    expect(api.status.value).toBe('ready')
    expect(api.noMask.value).toBe(true)
    expect(api.error.value).toBeNull()
    expect(slices.z.index).toBe(before)
    renderer.render.mockClear()
    api.resetView()
    expect(renderer.render).toHaveBeenCalled()
  })

  it('still reports any other mask 404 as a failure', async () => {
    const { api } = await mountScene()
    landVolume()
    gltfCall()[2].onError(httpError(404, { detail: { code: 'unknown_cohort', summary: 'x' } }))
    await flushPromises()
    expect(api.status.value).toBe('error')
    expect(api.noMask.value).toBe(false)
  })

  it('registers the scene with the shared budget, pinned, and releases it on unmount', async () => {
    const { wrapper } = await mountScene()
    const { volume } = landVolume()
    expect(budget.register).toHaveBeenCalledWith(expect.any(String), volume.data.byteLength)
    const key = budget.register.mock.calls[0]![0]
    expect(budget.pin).toHaveBeenCalledWith(key)
    // Another stage's scenes live on another renderer: this one never evicts them.
    expect(budget.overflow).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(budget.unpin).toHaveBeenCalledWith(key)
    expect(budget.release).toHaveBeenCalledWith(key)
  })

  it('disposes the scene on unmount', async () => {
    const { wrapper } = await mountScene()
    const { meshes } = landVolume()
    const signal: AbortSignal = nrrdCall()[3].signal
    const planeMaterial = meshes.z.material as MeshBasicMaterial
    const planeFreed = vi.spyOn(planeMaterial, 'dispose')
    const textureFreed = vi.spyOn(planeMaterial.map!, 'dispose')
    const geometryFreed = vi.spyOn(meshes.z.geometry, 'dispose')

    wrapper.unmount()

    expect(renderer.dispose).toHaveBeenCalledTimes(1)
    // This viewer owns its canvas outright, so its trackball's window listeners go too.
    expect(scene.controls.dispose).toHaveBeenCalledTimes(1)
    expect(planeFreed).toHaveBeenCalled()
    expect(textureFreed).toHaveBeenCalled()
    expect(geometryFreed).toHaveBeenCalled()
    expect(signal.aborted).toBe(true)

    // A mask that lands after unmount is not applied, and is freed.
    const late = makeMask()
    const lateMaterial = (late.children[0] as Mesh).material as MeshStandardMaterial
    const lateFreed = vi.spyOn(lateMaterial, 'dispose')
    landMask(late)
    expect(late.matrixAutoUpdate).toBe(true)
    expect((late.children[0] as Mesh).material).toBe(lateMaterial)
    expect(lateFreed).toHaveBeenCalled()
    expect(scene.scene.children).not.toContain(late)
  })

  it('frees the mask\'s materials on unmount', async () => {
    const { wrapper } = await mountScene()
    landVolume()
    const group = landMask()
    const freed = vi.spyOn(materialOf(group, 'channel_1'), 'dispose')
    wrapper.unmount()
    expect(freed).toHaveBeenCalled()
  })

  it('frees a volume that arrives after unmount without adding it', async () => {
    const { wrapper } = await mountScene()
    wrapper.unmount()
    const meshes = makeMeshes()
    const freed = vi.spyOn(meshes.x.material, 'dispose')
    landVolume(makeVolume(), meshes)
    expect(freed).toHaveBeenCalled()
    expect(scene.scene.children).not.toContain(meshes.x)
    expect(scene.loadGltf).not.toHaveBeenCalled()
    expect(budget.register).not.toHaveBeenCalled()
  })

  describe('slice views', () => {
    async function mountReady() {
      const mountedScene = await mountScene()
      const landed = landVolume()
      landMask()
      await nextTick()
      // The trackball listens for the wheel on the renderer's canvas, inside the host.
      const canvas = document.createElement('canvas')
      mountedScene.wrapper.element.appendChild(canvas)
      const zoom = vi.fn()
      canvas.addEventListener('wheel', zoom)
      return { ...mountedScene, ...landed, canvas, zoom }
    }

    function wheel(target: EventTarget, { ctrlKey = false, metaKey = false, ...init }: WheelEventInit = {}) {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ...init })
      // The test DOM's WheelEvent drops the modifier keys from its init.
      Object.defineProperties(event, { ctrlKey: { value: ctrlKey }, metaKey: { value: metaKey } })
      target.dispatchEvent(event)
      return event
    }

    const visible = (meshes: ReturnType<typeof makeMeshes>) => [meshes.x.visible, meshes.y.visible, meshes.z.visible]

    it('opens on the 3D view: all three planes, no slice number', async () => {
      const { api, meshes } = await mountReady()
      expect(api.view.value).toBe('3d')
      expect(api.slice.value).toBeNull()
      expect(visible(meshes)).toEqual([true, true, true])
    })

    it('shows one plane face-on in a single view, with its slice number', async () => {
      const { api, meshes, slices } = await mountReady()

      api.setView('sagittal')
      expect(api.view.value).toBe('sagittal')
      expect(visible(meshes)).toEqual([true, false, false])
      // From the patient's left, superior up (the validator's sagittal preset).
      expect(scene.camera.position.x).toBeGreaterThan(scene.controls.target.x)
      expect(scene.camera.up.z).toBeCloseTo(1, 9)
      expect(api.slice.value).toEqual({
        current: Math.round(slices.x.index / slices.x.RSARatio) + 1,
        total: 384,
      })

      api.setView('coronal')
      expect(visible(meshes)).toEqual([false, true, false])
      // From anterior.
      expect(scene.camera.position.y).toBeLessThan(scene.controls.target.y)
      expect(api.slice.value?.total).toBe(384)

      api.setView('axial')
      expect(visible(meshes)).toEqual([false, false, true])
      // From inferior, anterior up.
      expect(scene.camera.position.z).toBeLessThan(scene.controls.target.z)
      expect(scene.camera.up.y).toBeCloseTo(-1, 9)
      expect(api.slice.value?.total).toBe(104)

      api.setView('3d')
      expect(visible(meshes)).toEqual([true, true, true])
      expect(api.slice.value).toBeNull()
    })

    it('fills the stage with the single view\'s plane, not the whole volume', async () => {
      const { api } = await mountReady()
      const distance = () => scene.camera.position.distanceTo(scene.controls.target)
      const opening = distance()
      // The stage has no size here, so its aspect is 1 and the plane's longer
      // side meets the field of view: 90% of it, face-on. To 3 places: the plane
      // geometry is float32.
      const fit = (side: number) => side / 2 / Math.tan(Math.PI / 8) / 0.9

      api.setView('sagittal') // across: y, up: z
      expect(distance()).toBeCloseTo(fit(RAS[1]!), 3)
      expect(distance()).toBeLessThan(opening)
      api.setView('axial') // across: x, up: y
      expect(distance()).toBeCloseTo(fit(Math.max(RAS[0]!, RAS[1]!)), 3)
      api.setView('3d')
      expect(distance()).toBeCloseTo(opening, 6)
    })

    it('scrolls through the slices of a single view instead of zooming', async () => {
      const { api, slices, canvas, zoom } = await mountReady()
      api.setView('axial')
      const start = api.slice.value!.current
      const eye = scene.camera.position.clone()
      slices.z.repaint.mockClear()
      renderer.render.mockClear()

      const down = wheel(canvas, { deltaY: 100 })
      expect(down.defaultPrevented).toBe(true)
      expect(zoom).not.toHaveBeenCalled()
      expect(api.slice.value!.current).toBe(start + 1)
      // Slice number `n` (from 0) sits at `n * RSARatio`; the readout counts from 1.
      expect(slices.z.index).toBeCloseTo(start * slices.z.RSARatio, 9)
      expect(slices.z.repaint.mock.contexts.at(-1)).toBe(slices.z)
      expect(renderer.render).toHaveBeenCalled()
      expect(scene.camera.position.distanceTo(eye)).toBe(0)

      wheel(canvas, { deltaY: -3 })
      expect(api.slice.value!.current).toBe(start)

      // A sideways scroll moves nothing.
      wheel(canvas, { deltaY: 0, deltaX: 100 })
      expect(api.slice.value!.current).toBe(start)
    })

    it('stops at the first and the last slice', async () => {
      const { api, slices, canvas } = await mountReady()
      api.setView('axial')
      for (let i = 0; i < 200; i++) wheel(canvas, { deltaY: 100 })
      expect(api.slice.value).toEqual({ current: 104, total: 104 })
      expect(slices.z.index).toBeCloseTo(103 * 1.5, 9)
      for (let i = 0; i < 200; i++) wheel(canvas, { deltaY: -100 })
      expect(api.slice.value).toEqual({ current: 1, total: 104 })
      expect(slices.z.index).toBe(0)
    })

    it('leaves the wheel to the zoom with Ctrl or ⌘ held, and in the 3D view', async () => {
      const { api, slices, canvas, zoom } = await mountReady()
      const index = slices.z.index

      wheel(canvas)
      expect(zoom).toHaveBeenCalledTimes(1)

      api.setView('axial')
      const start = api.slice.value!.current
      expect(wheel(canvas, { ctrlKey: true }).defaultPrevented).toBe(false)
      wheel(canvas, { metaKey: true })
      expect(zoom).toHaveBeenCalledTimes(3)
      expect(api.slice.value!.current).toBe(start)
      expect(slices.z.index).toBe(index)
    })

    it('keeps a scrolled slice across view changes', async () => {
      const { api, canvas } = await mountReady()
      api.setView('axial')
      wheel(canvas)
      wheel(canvas)
      const scrolled = api.slice.value!.current
      api.setView('3d')
      api.setView('axial')
      expect(api.slice.value!.current).toBe(scrolled)
    })

    it('Reset goes back to the 3D view, the opening slices and the opening camera', async () => {
      const { api, meshes, slices, canvas } = await mountReady()
      const opening = [slices.x.index, slices.y.index, slices.z.index]
      const eye = scene.camera.position.clone()

      api.setView('sagittal')
      wheel(canvas)
      api.setView('axial')
      wheel(canvas)
      api.resetView()

      expect(api.view.value).toBe('3d')
      expect(api.slice.value).toBeNull()
      expect(visible(meshes)).toEqual([true, true, true])
      expect([slices.x.index, slices.y.index, slices.z.index]).toEqual(opening)
      expect(scene.camera.position.distanceTo(eye)).toBeCloseTo(0, 9)
    })

    it('ignores a view change before the scan is ready', async () => {
      const { api } = await mountScene()
      api.setView('axial')
      expect(api.view.value).toBe('3d')
      const { meshes } = landVolume()
      api.setView('axial') // the mask is still loading
      expect(api.view.value).toBe('3d')
      expect(visible(meshes)).toEqual([true, true, true])
    })

    it('offers the views on a scan with no marked areas', async () => {
      const { api } = await mountScene()
      const { meshes } = landVolume()
      gltfCall()[2].onError(httpError(404, { detail: { code: 'no_mask', summary: 'Cohort sub-1 has no mask.' } }))
      await flushPromises()
      api.setView('coronal')
      expect(visible(meshes)).toEqual([false, true, false])
    })

    it('stops listening for the wheel on unmount', async () => {
      const { wrapper, api, slices, canvas } = await mountReady()
      api.setView('axial')
      const index = slices.z.index
      wrapper.unmount()
      wheel(canvas)
      expect(slices.z.index).toBe(index)
    })
  })

  it('keeps one scene across a KeepAlive round trip and paints nothing while hidden', async () => {
    const show = ref(true)
    const sources = { mri: MRI, mask: MASK, findings: FINDINGS }
    const Other = defineComponent({ render: () => h('p', 'other page') })
    const Shell = defineComponent({
      setup: () => () => h(KeepAlive, null, [show.value ? h(Host, { sources, key: 'mri' }) : h(Other, { key: 'other' })]),
    })
    const wrapper = mount(Shell)
    mounted.push(wrapper)
    await flushPromises()

    show.value = false // leave mid-load
    await flushPromises()
    renderer.render.mockClear()
    landVolume()
    landMask()
    expect(renderer.render).not.toHaveBeenCalled()

    show.value = true
    await flushPromises()
    expect(renderer.render).toHaveBeenCalled()
    expect(copperRendererOnDemond).toHaveBeenCalledTimes(1)
    expect(renderer.createScene).toHaveBeenCalledTimes(1)
    expect(scene.loadNrrd).toHaveBeenCalledTimes(1)
  })
})
