import { AmbientLight, Box3, DirectionalLight, DoubleSide, MeshStandardMaterial, Vector3 } from 'three'
import type { Material, Matrix4, Mesh, Object3D } from 'three'
import { onActivated, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { MY_MRI_COPY } from '@/content/myMri'
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
import { placeInPatientFrame, worldFromLps } from '@/myMri/patientFrame'
import type { FindingSummary } from '@/myMri/useMyMriSession'

/**
 * The patient's MRI as three orthogonal slice planes, with the Clinician Layer
 * mask over them as one coloured mesh per finding.
 *
 * This is the validator's ground-truth 3D view (`RightPanelCore.vue`'s scene and
 * NRRD callback, `useRightPanelModels.ts`'s mesh loading) cut down to what a
 * patient needs: no view switching, no brightness, no slice scrubbing. The
 * planes are placed once, through the marked area.
 *
 * Where it differs from the validator:
 *
 * - The camera frames the planes, and the planes show the volume's own
 *   intensity range. The validator frames a body box and applies a default
 *   window, both measured by its backend; this backend measures neither.
 * - The mask goes through `copperSceneOnDemond.loadGltf`; `loadPureGLB` exists
 *   only on `copperScene`. `loadGltf` recentres the group's `position`, bounds
 *   the dolly on the model and (unless `cameraPositionFlag` is set) frames the
 *   camera on it. `placeInPatientFrame` turns `matrixAutoUpdate` off, so the
 *   recentred `position` is never read; the flag and `limitDolly` undo the rest.
 * - Frames are drawn on demand, so every change that should show calls `draw`.
 */

/**
 * The validator's axial preset (`assets/nrrd_view_axial.json`), which its
 * combined 3D view opens on: the eye inferior, anterior up, so the patient is
 * seen the way the 2D axial view shows them. `fitView` keeps its direction and
 * up and replaces only the distance.
 */
const VIEW_PRESET: CopperViewPoint = {
  farPlane: 1000,
  nearPlane: 0.01,
  eyePosition: [0, 0, -600],
  targetPosition: [0, 0, 0],
  upVector: [0, -1, 0],
}

/** A mesh with no finding (or an unusable colour) is drawn in this neutral grey. */
const NEUTRAL_COLOR = '#94a3b8'
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const MESH_OPACITY = 0.5

/** The colour a finding's mesh is drawn in, which its legend dot must match:
 *  its own `#rrggbb`, or the neutral grey (the backend's rule too). */
export function meshColour(color: string | undefined): string {
  return color !== undefined && HEX_COLOR.test(color) ? color : NEUTRAL_COLOR
}
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
      color: meshColour(channel !== undefined ? colours.get(channel) : undefined),
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

function boundsRadius(bounds: FitBounds): number {
  return Math.hypot(bounds.width, bounds.height, bounds.depth) / 2
}

/**
 * `host` is the element the renderer's canvas goes in. `sources` is read once:
 * a different scan is a different viewer (the page keys it by URL).
 */
export function useMyMriScene(host: Ref<HTMLElement | null>, sources: MyMriSources) {
  const status = ref<MyMriSceneStatus>('loading')
  const error = ref<string | null>(null)

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

  /** The trackball's dolly limits, from the planes. */
  function limitDolly() {
    if (!scene || !bounds) return
    const radius = boundsRadius(bounds)
    scene.controls.minDistance = radius * MIN_DISTANCE_FACTOR
    scene.controls.maxDistance = radius * MAX_DISTANCE_FACTOR
  }

  /**
   * The opening camera, which Reset restores: the preset's direction and up,
   * at the distance that fits the planes into the stage's current aspect.
   * `setCameraPose` writes the up vector, which `fitView` does not touch.
   */
  function frame() {
    if (!scene) return
    const { camera } = scene
    camera.near = VIEW_PRESET.nearPlane
    setCameraPose(scene, viewPointToPose(VIEW_PRESET))
    if (bounds) {
      fitView(scene, VIEW_PRESET, stage.aspect(), bounds)
      limitDolly()
      // The preset's far plane does not cover a fully zoomed-out camera.
      camera.far = Math.max(VIEW_PRESET.farPlane, boundsRadius(bounds) * (MAX_DISTANCE_FACTOR + 1))
    }
    else {
      camera.far = VIEW_PRESET.farPlane
    }
    camera.updateProjectionMatrix()
    posed = false
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

    // A real gesture means the reader has chosen this camera.
    inputHost = host.value ?? undefined
    inputHost?.addEventListener('pointerdown', markPosed)
    inputHost?.addEventListener('wheel', markPosed, { passive: true })

    frame()
    loadVolume(created, Copper)
  }

  function loadVolume(target: CopperScene, Copper: CopperModule) {
    arm(NRRD_STALL_TIMEOUT_MS, MY_MRI_COPY.viewerErrors.stalled)
    target.loadNrrd(
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

  function onVolume(target: CopperScene, volume: NrrdVolume, meshes: NrrdMeshes, slices: Slices) {
    const planes = [meshes.x, meshes.y, meshes.z] as unknown as Mesh[]
    if (disposed || failed) {
      // Never added to a scene, so nothing else will free them.
      for (const plane of planes) disposeObject3D(plane)
      return
    }
    clearTimer()

    showSliceGreysAsIs(planes)
    for (const plane of planes) {
      plane.renderOrder = PLANE_RENDER_ORDER
      target.addObject(plane)
    }

    // The field of view is the box of the three planes, measured from the
    // meshes so it carries the volume's own offset.
    const field = new Box3()
    for (const plane of planes) field.expandByObject(plane)
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

    if (!posed) frame()
    draw()
    loadMask(target, worldFromLps(volume.orientation.geometry, volume.RASDimensions), slices)
  }

  function loadMask(target: CopperScene, toWorld: Matrix4, slices: Slices) {
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
        placeInPatientFrame(group, toWorld)
        colourMask(group, sources.findings)
        const marked = new Box3().setFromObject(group)
        if (!marked.isEmpty()) centreSlicesOn(slices, marked.getCenter(new Vector3()))
        status.value = 'ready'
        draw()
      },
      { onError: err => fail(err, MY_MRI_COPY.viewerErrors.mask) },
    )
  }

  /** Back to the opening camera. */
  function resetView() {
    if (!scene) return
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
    if (registered) {
      getSceneBudget().unpin(sceneName)
      getSceneBudget().release(sceneName)
    }
    // Unregisters the scene and frees every child's geometry, materials and
    // textures (the planes' canvas textures included). The renderer itself is
    // disposed by the stage right after this.
    const renderer = stage.renderer.value
    if (scene && renderer) disposeScene(renderer, sceneName)
    scene = undefined
  }

  return { status, error, resetView }
}
