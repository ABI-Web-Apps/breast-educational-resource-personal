import { AmbientLight, Box3, DirectionalLight, DoubleSide, MathUtils, MeshStandardMaterial, Vector3 } from 'three'
import type { Material, Matrix4, Mesh, Object3D, PerspectiveCamera } from 'three'
import { onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { MY_MRI_COPY } from '@/content/myMri'
import { loadNrrdVolume } from '@/composables/loadNrrdVolume'
import type { CopperModule, CopperScene, CopperViewPoint, NrrdMeshes, NrrdSlice, NrrdVolume } from '@/composables/copper-types'
import type { FitBounds } from '@/composables/copperExtras'
import {
  disposeMaterial,
  disposeObject3D,
  disposeScene,
  fitView,
  OrientationError,
  setCameraPose,
  viewPointToPose,
} from '@/composables/copperExtras'
import { getSceneBudget } from '@/composables/sceneBudget'
import { useCopperStage } from '@/composables/useCopperStage'
import { isAbort } from '@/myMri/api'
import { findingColour } from '@/myMri/findingColour'
import { placeInPatientFrame, worldFromLps } from '@/myMri/patientFrame'
import type { FindingSummary } from '@/myMri/useMyMriSession'

/**
 * The patient's MRI as three orthogonal slice planes, with the Clinician Layer
 * mask over them as one coloured mesh per finding.
 *
 * This is the validator's ground-truth 3D view (`RightPanelCore.vue`'s scene,
 * NRRD callback, view switching and wheel, `useRightPanelModels.ts`'s mesh
 * loading) cut down to what a patient needs: no brightness, no layers. The
 * planes open through the marked area, in the 3D view.
 *
 * Where it differs from the validator:
 *
 * - The camera frames the planes, and the planes open on a 1st-99th percentile
 *   window measured here from the loaded voxels. The validator frames a body
 *   box and applies a default window, both measured by its backend; this
 *   backend measures neither.
 * - One click on a view both shows its plane and turns the camera to face it;
 *   the validator keeps the camera on a single click and turns it on a double
 *   click. A single view has no volume box around its plane.
 * - Reset is the validator's nav-bar reset plus the opening slices: the 3D
 *   view, the planes back through the marked area, the opening camera.
 * - The mask goes through `copperSceneOnDemond.loadGltf`; `loadPureGLB` exists
 *   only on `copperScene`. `loadGltf` recentres the group's `position`, bounds
 *   the dolly on the model and (unless `cameraPositionFlag` is set) frames the
 *   camera on it. `placeInPatientFrame` turns `matrixAutoUpdate` off, so the
 *   recentred `position` is never read; the flag and `limitDolly` undo the rest.
 * - Frames are drawn on demand, so every change that should show calls `draw`.
 */

/** What the stage shows: the three planes together, or one of them face-on. */
export type MyMriView = '3d' | 'axial' | 'coronal' | 'sagittal'

/** Where a single view is, counted from 1 as the reader counts slices. */
export interface SliceReadout {
  current: number
  total: number
}

type Axis = 'x' | 'y' | 'z'
const AXES: readonly Axis[] = ['x', 'y', 'z']

/** The plane each single view shows. The world is canonical LPS (see `patientFrame`). */
const VIEW_AXIS: Record<Exclude<MyMriView, '3d'>, Axis> = { sagittal: 'x', coronal: 'y', axial: 'z' }

/**
 * The validator's presets (`assets/nrrd_view_*.json`). Each single view looks at
 * its plane the way the 2D views show the patient: axial from inferior with
 * anterior up, coronal from anterior and sagittal from the patient's left, both
 * superior up. The 3D view opens on the axial preset. `fitView` keeps a preset's
 * direction and up and replaces only the distance.
 */
const AXIAL_PRESET: CopperViewPoint = {
  farPlane: 1000,
  nearPlane: 0.01,
  eyePosition: [0, 0, -600],
  targetPosition: [0, 0, 0],
  upVector: [0, -1, 0],
}
/** The plane's extents that lie across and up the screen in each single view, from its preset. */
const VIEW_SCREEN_AXES: Record<Exclude<MyMriView, '3d'>, [Axis, Axis]> = {
  sagittal: ['y', 'z'],
  coronal: ['x', 'z'],
  axial: ['x', 'y'],
}
/** How much of the stage a single view's plane fills along its tighter side. */
const PLANE_FILL = 0.9

const VIEW_PRESETS: Record<MyMriView, CopperViewPoint> = {
  '3d': AXIAL_PRESET,
  'axial': AXIAL_PRESET,
  'coronal': { farPlane: 1000, nearPlane: 0.01, eyePosition: [0, -500, 0], targetPosition: [0, 0, 0], upVector: [0, 0, 1] },
  'sagittal': { farPlane: 1000, nearPlane: 0.01, eyePosition: [500, 0, 0], targetPosition: [0, 0, 0], upVector: [0, 0, 1] },
}

const MESH_OPACITY = 0.5
/** Planes first, then the translucent mesh over them. */
const PLANE_RENDER_ORDER = 1
const MESH_RENDER_ORDER = 4

/** The case viewers' trackball numbers (see `useModalityScene`). The validator's
 *  2.0 / 0.8 are tuned for a continuous loop without `updateOnInput`. */
const ROTATE_SPEED = 1.5
const PAN_SPEED = 0.5
/** Dolly limits, as multiples of the planes' bounding-sphere radius (the validator's). */
const MIN_DISTANCE_FACTOR = 0.3
const MAX_DISTANCE_FACTOR = 20

/** No download progress for this long means the transfer is wedged. Not a total
 *  deadline: a slow but healthy download keeps re-arming it. */
const NRRD_STALL_TIMEOUT_MS = 15_000
/** The mask has no progress signal worth watching (the backend builds the mesh
 *  before it answers), so it gets a flat net under `onError`. */
const GLB_LOAD_TIMEOUT_MS = 30_000

/** The opening display window's percentiles: the ones the report's slice images use. */
const WINDOW_PERCENTILES: [number, number] = [1, 99]
/** Histogram resolution and sample cap for measuring them (`exposureExponent`'s). */
const WINDOW_BINS = 4096
const WINDOW_MAX_SAMPLES = 4_000_000

export interface MyMriSources {
  mri: string
  mask: string
  findings: FindingSummary[]
}

export type MyMriSceneStatus = 'loading' | 'ready' | 'error'

/** The slice planes opt out of tone mapping and show the image's own greys,
 *  as 3D Slicer does (the validator's `showSliceGreysAsIs`). */
function showSliceGreysAsIs(planes: Mesh[]): void {
  for (const plane of planes) {
    const materials = Array.isArray(plane.material) ? plane.material : [plane.material]
    for (const material of materials) {
      material.toneMapped = false
      material.needsUpdate = true
    }
  }
}

/**
 * The validator's light rig. copper3d parents most of its lights to the camera,
 * which is not in the scene graph, so they light nothing; the only live light is
 * a hemisphere light whose ground colour is near black, which leaves the
 * underside of a PBR mesh black. Dim it and add fill from below.
 */
function addSceneLights(target: CopperScene): void {
  const hemi = target.scene.getObjectByName('hemi_light') as unknown as { intensity: number } | undefined
  if (hemi) hemi.intensity = 0.6
  const ambient = new AmbientLight(0xffffff, 0.08)
  ambient.name = 'my_mri_ambient'
  target.addObject(ambient)
  const fills: [number, number, number, number][] = [[0.4, -1, 0.6, 0.45], [-0.4, -1, -0.4, 0.3]]
  fills.forEach(([x, y, z, intensity], i) => {
    const light = new DirectionalLight(0xffffff, intensity)
    light.position.set(x, y, z)
    light.name = `my_mri_fill_${i}`
    target.addObject(light)
  })
}

/** The label a mask node was exported for: its own name, or its nearest ancestor's. */
function channelOf(object: Object3D): number | undefined {
  for (let node: Object3D | null = object; node; node = node.parent) {
    const match = /^channel_(\d+)$/.exec(node.name)
    if (match) return Number(match[1])
  }
  return undefined
}

/**
 * Gives every mask mesh its finding's colour, so a shape, its legend entry and
 * its finding in the report are the same colour.
 *
 * A fresh material per mesh rather than the GLB's own: the GLB carries per-vertex
 * colours that would multiply the finding colour, and two nodes may share one
 * material. The PBR values are what the validator's `loadPureGLB` gives a mask.
 * `depthWrite` stays off so the translucent mesh never punches a hole in the
 * planes behind it.
 */
function colourMask(group: Object3D, findings: FindingSummary[]): void {
  const colours = new Map(findings.map(f => [f.channel, f.color]))
  const replaced = new Set<Material>()
  group.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    const channel = channelOf(mesh)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) replaced.add(material)
    mesh.material = new MeshStandardMaterial({
      // A channel no finding names gets the neutral grey too.
      color: findingColour(channel !== undefined ? colours.get(channel) : undefined),
      roughness: 0.35,
      metalness: 0.05,
      envMapIntensity: 1.2,
      side: DoubleSide,
      transparent: true,
      opacity: MESH_OPACITY,
      depthWrite: false,
    })
    mesh.renderOrder = MESH_RENDER_ORDER
  })
  group.renderOrder = MESH_RENDER_ORDER
  for (const material of replaced) disposeMaterial(material)
}

type Slices = { x?: NrrdSlice, y?: NrrdSlice, z: NrrdSlice }

/**
 * Moves each plane through `centre`, as the validator's `loadPrimaryMesh` does for
 * the primary mesh: the plane for slice `index` sits at `index - RSAMaxIndex / 2`
 * in the world, so the planes then cut through the marked area and the mesh
 * sits on the image it was drawn from.
 */
function centreSlicesOn(slices: Slices, centre: Vector3): void {
  for (const [slice, at] of [[slices.x, centre.x], [slices.y, centre.y], [slices.z, centre.z]] as const) {
    if (!slice) continue
    slice.index = slice.RSAMaxIndex / 2 + at
    slice.repaint.call(slice)
  }
}

/** The slice number (from 0) a plane is on. A plane centred on the marked area can sit between two. */
function sliceNumber(slice: NrrdSlice): number {
  return Math.min(slice.MaxIndex, Math.max(0, Math.round(slice.index / slice.RSARatio)))
}

/**
 * The display window the planes open on: the `low`th to `high`th percentile of
 * the volume's intensities, measured from a histogram over `[min, max]` of at
 * most `WINDOW_MAX_SAMPLES` evenly strided voxels. The loader's own window is
 * the full `min`..`max`, which a few bright voxels stretch until the tissue is
 * dark. Undefined for a volume with no range, which keeps its own window.
 */
function percentileWindow(
  volume: { data: ArrayLike<number>, min: number, max: number },
  [low, high]: [number, number] = WINDOW_PERCENTILES,
): [number, number] | undefined {
  const { data, min, max } = volume
  if (data.length === 0 || !(max > min)) return undefined
  const scale = WINDOW_BINS / (max - min)
  const stride = Math.max(1, Math.floor(data.length / WINDOW_MAX_SAMPLES))
  const histogram = new Uint32Array(WINDOW_BINS)
  let sampled = 0
  for (let i = 0; i < data.length; i += stride) {
    const bin = Math.floor((data[i]! - min) * scale)
    histogram[Math.min(WINDOW_BINS - 1, Math.max(0, bin))]!++
    sampled++
  }
  const binAt = (percent: number) => {
    const target = (sampled * percent) / 100
    let seen = 0
    for (let bin = 0; bin < WINDOW_BINS; bin++) {
      seen += histogram[bin]!
      if (seen >= target) return bin
    }
    return WINDOW_BINS - 1
  }
  // The low bin's lower edge and the high bin's upper edge, so neither end clips early.
  const windowLow = min + binAt(low) / scale
  const windowHigh = Math.min(max, min + (binAt(high) + 1) / scale)
  return windowHigh > windowLow ? [windowLow, windowHigh] : undefined
}

/**
 * Whether a failed mask load is the backend's 404 `no_mask`: a scan with
 * nothing marked, which is not a failure. three's `FileLoader` rejects a
 * non-2xx with an error carrying the `Response`, whose body is unread.
 */
async function isNoMask(err: unknown): Promise<boolean> {
  const response = (err as { response?: unknown } | null)?.response
  if (!(response instanceof Response) || response.status !== 404) return false
  try {
    const body = await response.clone().json() as { detail?: { code?: unknown } } | null
    return body?.detail?.code === 'no_mask'
  }
  catch {
    return false
  }
}

function boundsRadius(bounds: FitBounds): number {
  return Math.hypot(bounds.width, bounds.height, bounds.depth) / 2
}

/**
 * How far back a camera facing a plane head-on sits for the plane to fill
 * `PLANE_FILL` of the stage: whichever of its width against the horizontal
 * field of view and its height against the vertical one needs more room.
 */
function faceOnDistance(across: number, up: number, fovDegrees: number, aspect: number): number {
  const vHalf = MathUtils.degToRad(fovDegrees) / 2
  const hHalf = Math.atan(Math.tan(vHalf) * aspect)
  return Math.max(across / 2 / Math.tan(hHalf), up / 2 / Math.tan(vHalf)) / PLANE_FILL
}

/**
 * `host` is the element the renderer's canvas goes in. `sources` is read once:
 * a different scan is a different viewer (the page keys it by URL).
 */
export function useMyMriScene(host: Ref<HTMLElement | null>, sources: MyMriSources) {
  const status = ref<MyMriSceneStatus>('loading')
  const error = ref<string | null>(null)
  /** The scan has no marked areas: the planes show alone, and that is not an error. */
  const noMask = ref(false)
  const view = ref<MyMriView>('3d')
  /** The single view's slice; null in the 3D view, where no one slice is "the" slice. */
  const slice = ref<SliceReadout | null>(null)

  /** The renderer's scene map and the shared budget both key on this. */
  const sceneName = `my-mri:${sources.mri}`
  const controller = new AbortController()

  let scene: CopperScene | undefined
  /** The planes' box: what the camera frames and Reset restores. */
  let bounds: FitBounds | undefined
  let registered = false
  let failed = false
  let disposed = false
  /** False while KeepAlive has the page hidden: nothing is drawn then. */
  let active = true
  /** Set by the reader's first gesture; a resize then leaves their camera alone. */
  let posed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inputHost: HTMLElement | undefined
  let planes: Record<Axis, Mesh> | undefined
  let slices: Slices | undefined
  /** Where each plane opened, which Reset puts it back to. */
  const openingIndex: Partial<Record<Axis, number>> = {}

  // Registered before the stage's own disposal, so the scene's GPU resources are
  // freed while the renderer that owns them still exists.
  onScopeDispose(teardown)

  const stage = useCopperStage(host, {
    onResize: () => {
      if (posed) return
      frame()
      draw()
    },
  })

  watch(stage.ready, (ready) => {
    if (ready) start()
  })
  watch(stage.loadError, (err) => {
    if (err) fail(err, MY_MRI_COPY.viewerErrors.viewer)
  })

  onDeactivated(() => { active = false })
  onActivated(() => {
    active = true
    if (!posed) frame()
    draw()
  })

  function markPosed() {
    posed = true
  }

  function draw() {
    const renderer = stage.renderer.value
    if (disposed || !active || !scene || !renderer) return
    renderer.render()
  }

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function arm(ms: number, message: string) {
    clearTimer()
    timer = setTimeout(() => fail(new Error(message), message), ms)
  }

  function fail(err: unknown, message: string) {
    if (disposed || failed || isAbort(err)) return
    failed = true
    clearTimer()
    // A stalled download is still running; nothing more is wanted from it.
    controller.abort()
    error.value = err instanceof OrientationError ? MY_MRI_COPY.viewerErrors.orientation : message
    status.value = 'error'
  }

  /**
   * The trackball's dolly limits, from the planes, and a far plane that covers
   * a fully zoomed-out camera (the preset's 1000 does not).
   */
  function limitDolly() {
    if (!scene || !bounds) return
    const radius = boundsRadius(bounds)
    scene.controls.minDistance = radius * MIN_DISTANCE_FACTOR
    scene.controls.maxDistance = radius * MAX_DISTANCE_FACTOR
    scene.camera.far = Math.max(VIEW_PRESETS[view.value].farPlane, radius * (MAX_DISTANCE_FACTOR + 1))
    scene.camera.updateProjectionMatrix()
  }

  /**
   * The current view's camera: its preset's direction and up, at the distance
   * that fits the planes into the stage's current aspect. `setCameraPose`
   * writes the up vector, which `fitView` does not touch. A single view then
   * moves in on its own plane.
   */
  function frame() {
    if (!scene) return
    const { camera } = scene
    const preset = VIEW_PRESETS[view.value]
    camera.near = preset.nearPlane
    setCameraPose(scene, viewPointToPose(preset))
    if (bounds) {
      fitView(scene, preset, stage.aspect(), bounds)
      if (view.value !== '3d') faceOn(view.value)
      limitDolly()
    }
    else {
      camera.far = preset.farPlane
      camera.updateProjectionMatrix()
    }
    posed = false
  }

  /**
   * Centres the camera on a single view's plane, as close as fills the stage
   * with it. `fitView` fits a bounding sphere, which suits the 3D view's
   * any-angle box but leaves a plane seen head-on small; this keeps the
   * direction `fitView` set and replaces the distance.
   */
  function faceOn(single: Exclude<MyMriView, '3d'>) {
    const plane = planes?.[VIEW_AXIS[single]]
    if (!scene || !plane) return
    const box = new Box3().setFromObject(plane)
    if (box.isEmpty()) return
    const size = box.getSize(new Vector3())
    const centre = box.getCenter(new Vector3())
    const camera = scene.camera as unknown as PerspectiveCamera
    const target = scene.controls.target as unknown as Vector3
    const direction = camera.position.clone().sub(target).normalize()
    const [across, up] = VIEW_SCREEN_AXES[single]
    const distance = faceOnDistance(size[across], size[up], camera.fov, stage.aspect())
    camera.position.copy(centre).addScaledVector(direction, distance)
    camera.lookAt(centre)
    target.copy(centre)
  }

  function activeSlice(): NrrdSlice | undefined {
    return view.value === '3d' ? undefined : slices?.[VIEW_AXIS[view.value]]
  }

  function readSlice() {
    const active = activeSlice()
    slice.value = active ? { current: sliceNumber(active) + 1, total: active.MaxIndex + 1 } : null
  }

  /** Shows the view's plane, or all three for the 3D view, and leaves the camera alone. */
  function showView(next: MyMriView) {
    if (!planes) return
    view.value = next
    for (const axis of AXES) planes[axis].visible = next === '3d' || VIEW_AXIS[next] === axis
    readSlice()
  }

  function rememberOpeningSlices() {
    for (const axis of AXES) {
      const at = slices?.[axis]
      if (at) openingIndex[axis] = at.index
    }
  }

  function restoreOpeningSlices() {
    for (const axis of AXES) {
      const at = slices?.[axis]
      const index = openingIndex[axis]
      if (!at || index === undefined || at.index === index) continue
      at.index = index
      at.repaint.call(at)
    }
  }

  /** One slice on in the single view, clamped to the scan. */
  function stepSlice(step: number) {
    const active = activeSlice()
    if (!active) return
    active.index = Math.min(active.MaxIndex, Math.max(0, sliceNumber(active) + step)) * active.RSARatio
    active.repaint.call(active)
    readSlice()
    draw()
  }

  /**
   * In a single view the wheel moves through the slices (the PACS convention,
   * the validator's `onPanelWheel`); with Ctrl or ⌘ held, and always in the 3D
   * view, it falls through to the trackball's zoom. Registered on the host in
   * the capture phase so it runs before the trackball's own listener on the
   * canvas inside it; stopping the event there also keeps a slice step from
   * counting as a camera gesture (`markPosed`).
   */
  function onWheel(event: WheelEvent) {
    if (disposed || view.value === '3d' || event.ctrlKey || event.metaKey || event.deltaY === 0) return
    event.preventDefault()
    event.stopPropagation()
    stepSlice(event.deltaY > 0 ? 1 : -1)
  }

  /** Shows a view and turns the camera to face it. Waits for the scan, mask included. */
  function setView(next: MyMriView) {
    if (status.value !== 'ready' || !planes) return
    showView(next)
    frame()
    draw()
  }

  function start() {
    const renderer = stage.renderer.value
    const Copper = stage.Copper.value
    if (disposed || failed || scene || !renderer || !Copper) return

    const created = renderer.createScene(sceneName, { controls: 'copper3d' })
    if (!created) {
      fail(new Error(`copper3d refused to create scene "${sceneName}"`), MY_MRI_COPY.viewerErrors.viewer)
      return
    }
    // The stage's ResizeObserver already resizes the scene; this listener would
    // only leak (see useModalityScene).
    window.removeEventListener('resize', created.confirmResize, false)
    scene = created
    created.cameraPositionFlag = true
    renderer.setCurrentScene(created)
    created.controls.staticMoving = true
    created.controls.rotateSpeed = ROTATE_SPEED
    created.controls.panSpeed = PAN_SPEED
    addSceneLights(created)

    frame()
    loadVolume(created, Copper)
  }

  function loadVolume(target: CopperScene, Copper: CopperModule) {
    arm(NRRD_STALL_TIMEOUT_MS, MY_MRI_COPY.viewerErrors.stalled)
    loadNrrdVolume(
      target,
      sources.mri,
      Copper.loading(),
      (volume, meshes, slices) => onVolume(target, volume, meshes, slices),
      {
        openGui: false,
        // All three planes: the combined view shows x, y and z at once.
        axes: ['x', 'y', 'z'],
        signal: controller.signal,
        onProgress: () => {
          if (!disposed && !failed) arm(NRRD_STALL_TIMEOUT_MS, MY_MRI_COPY.viewerErrors.stalled)
        },
        // A network or parse failure, or an `OrientationError` for a volume the
        // loader will not orient. Either way: a message, never a blank stage.
        onError: err => fail(err, MY_MRI_COPY.viewerErrors.scan),
      },
    )
  }

  function onVolume(target: CopperScene, volume: NrrdVolume, meshes: NrrdMeshes, landed: Slices) {
    const byAxis = { x: meshes.x, y: meshes.y, z: meshes.z } as unknown as Record<Axis, Mesh>
    const all = AXES.map(axis => byAxis[axis])
    if (disposed || failed) {
      // Never added to a scene, so nothing else will free them.
      for (const plane of all) disposeObject3D(plane)
      return
    }
    clearTimer()

    showSliceGreysAsIs(all)
    for (const plane of all) {
      plane.renderOrder = PLANE_RENDER_ORDER
      target.addObject(plane)
    }
    planes = byAxis
    slices = landed
    rememberOpeningSlices()

    // The field of view is the box of the three planes, measured from the
    // meshes so it carries the volume's own offset.
    const field = new Box3()
    for (const plane of all) field.expandByObject(plane)
    if (!field.isEmpty()) {
      const size = field.getSize(new Vector3())
      const centre = field.getCenter(new Vector3())
      bounds = { width: size.x, height: size.y, depth: size.z, center: [centre.x, centre.y, centre.z] }
      // Rotation turns the planes about their own centre, even after a pan.
      target.controls.rotationPivot = centre
    }

    // Counted against the budget the case stages share, and pinned: this
    // renderer has no other scene to give up, and the budget's victims belong
    // to the case stages' renderers, which apply it on their next load.
    const bytes = (volume.data as { byteLength?: number }).byteLength ?? 0
    getSceneBudget().register(sceneName, bytes)
    getSceneBudget().pin(sceneName)
    registered = true

    // Open on the 1st-99th percentile window (the validator applies a measured
    // default window the same way), repainting the slices the loader painted
    // with the full range.
    const greyWindow = percentileWindow(volume)
    if (greyWindow) {
      volume.windowLow = greyWindow[0]
      volume.windowHigh = greyWindow[1]
      volume.repaintAllSlices()
    }

    frame()
    draw()
    // A real gesture means the reader has chosen this camera. Only from here
    // on: input while the volume loads must not cost it its opening fit.
    inputHost = host.value ?? undefined
    inputHost?.addEventListener('pointerdown', markPosed)
    inputHost?.addEventListener('wheel', markPosed, { passive: true })
    inputHost?.addEventListener('wheel', onWheel, { capture: true, passive: false })

    loadMask(target, worldFromLps(volume.orientation.geometry, volume.RASDimensions), landed)
  }

  function loadMask(target: CopperScene, toWorld: Matrix4, landed: Slices) {
    arm(GLB_LOAD_TIMEOUT_MS, MY_MRI_COPY.viewerErrors.mask)
    target.loadGltf(
      sources.mask,
      (content) => {
        const group = content as unknown as Object3D
        if (disposed || failed) {
          // `loadGltf` has already added it to the scene.
          target.scene.remove(content)
          disposeObject3D(group)
          return
        }
        clearTimer()
        // `loadGltf` bounded the dolly on the mask; the limits come from the planes.
        limitDolly()
        // `loadGltf` recentred the group on its own box. The matrix below is what
        // places it, but a stale offset must not survive to be read back.
        group.position.set(0, 0, 0)
        placeInPatientFrame(group, toWorld)
        colourMask(group, sources.findings)
        const marked = new Box3().setFromObject(group)
        if (!marked.isEmpty()) {
          centreSlicesOn(landed, marked.getCenter(new Vector3()))
          rememberOpeningSlices()
        }
        status.value = 'ready'
        draw()
      },
      { onError: (err) => { void onMaskError(err) } },
    )
  }

  async function onMaskError(err: unknown) {
    if (disposed || failed) return
    if (!(await isNoMask(err))) {
      fail(err, MY_MRI_COPY.viewerErrors.mask)
      return
    }
    if (disposed || failed) return
    clearTimer()
    noMask.value = true
    status.value = 'ready'
    draw()
  }

  /** Back to how the viewer opened: the 3D view, the opening slices, the opening camera. */
  function resetView() {
    if (!scene) return
    restoreOpeningSlices()
    showView('3d')
    frame()
    draw()
  }

  function teardown() {
    disposed = true
    clearTimer()
    // Stops the volume's transfer; a mask still in flight is dropped on arrival.
    controller.abort()
    inputHost?.removeEventListener('pointerdown', markPosed)
    inputHost?.removeEventListener('wheel', markPosed)
    inputHost?.removeEventListener('wheel', onWheel, { capture: true })
    if (registered) {
      getSceneBudget().unpin(sceneName)
      getSceneBudget().release(sceneName)
    }
    // Unregisters the scene and frees every child's geometry, materials and
    // textures (the planes' canvas textures included). The renderer itself is
    // disposed by the stage right after this.
    const renderer = stage.renderer.value
    if (scene && renderer) {
      disposeScene(renderer, sceneName)
      // `disposeScene` leaves the controls attached because a renderer's scenes
      // share one canvas. This renderer and its canvas are this view's alone and
      // go with it, so the trackball's own canvas and window listeners go too.
      scene.controls.dispose()
    }
    scene = undefined
    planes = undefined
    slices = undefined
  }

  return { status, error, noMask, view, slice, setView, resetView }
}
