import type { Pose } from '@/composables/copperExtras'
import type { PanelId } from '@/content/types'

/**
 * What the tour is allowed to ask a stage to do.
 *
 * Deliberately narrow and deliberately plain: no refs, no three.js types,
 * no copper3d types. The tour director talks to this and nothing else, so
 * it can be unit-tested in happy-dom against a plain object while the real
 * WebGL implementation stays entirely inside CopperStage.
 */
export interface TourStageApi {
  isReady: () => boolean
  isFailed: () => boolean
  snapshot: () => Pose | null
  applyPose: (pose: Pose) => void
  /** Eased yaw sweep. Resolves when it lands or is interrupted. */
  orbit: (yawRad: number, durationMs: number) => Promise<void>
  scrubTo: (index: number) => void
  /** The slice on screen right now. The scrub demo has to put the reader
   *  back where they were, and without this it could only guess. */
  sliceIndex: () => number
  sliceMax: () => number
  /** Fractional load progress, 0..1. NaN is possible mid-flight; treat any
   *  change as progress. GLB loads only ever report 0 then 1. */
  loadProgress: () => number
  lesionSliceIndex: () => number
  locate: () => void
  reset: () => void
  prefersReducedMotion: () => boolean
}

/**
 * Module-level, not provide/inject: TourLayer is a sibling of the stages,
 * not an ancestor, so there is no shared provider to hang this on. This is
 * not an event bus -- nothing is emitted or subscribed; it is a lookup
 * table each stage owns one row of, cleared on unmount.
 */
const stages = new Map<PanelId, TourStageApi>()

export function registerTourStage(id: PanelId, api: TourStageApi) {
  stages.set(id, api)
}

export function unregisterTourStage(id: PanelId) {
  stages.delete(id)
}

export function getTourStage(id: PanelId): TourStageApi | undefined {
  return stages.get(id)
}

/** Tests only. */
export function clearTourStages() {
  stages.clear()
}
