/**
 * Where patient space sits in the 3D view's world. Ported from the validator's
 * `components/viewer/patientFrame.ts`.
 *
 * The world is the frame three.js builds slice planes in for a volume loaded by
 * voxel index: canonical index × spacing, centred per axis by three's plane
 * offset `(RASDimensions - 1) / 2` (`Volume.extractPerpendicularPlane`). copper3d
 * loads every volume in the canonical order (i -> Left, j -> Posterior,
 * k -> Superior), so that frame is the patient's own, up to the acquisition's
 * obliquity.
 *
 * The mask mesh is in patient LPS millimetres and goes through this one mapping:
 *
 *   world = diag(spacing) · D⁻¹ · (p - origin) - (RASDimensions - 1) / 2
 *
 * D holds the canonical grid's direction vectors (obliquity included). For an
 * axis-aligned volume it reduces to `p - origin - (RASDimensions - 1) / 2`.
 */
import { Matrix4 } from 'three'
import type { Object3D } from 'three'
import type { VolumeGeometry } from 'copper3d'

/** The 4x4 matrix taking patient LPS millimetres to the 3D view's world. */
export function worldFromLps(geometry: VolumeGeometry, rasDimensions: ArrayLike<number>): Matrix4 {
  const [d0, d1, d2] = geometry.directions
  // Columns are the direction vectors: index -> LPS offset.
  const indexToLps = new Matrix4().set(
    d0[0], d1[0], d2[0], 0,
    d0[1], d1[1], d2[1], 0,
    d0[2], d1[2], d2[2], 0,
    0, 0, 0, 1,
  )
  const [s0, s1, s2] = geometry.directions.map(d => Math.hypot(d[0], d[1], d[2])) as [number, number, number]
  const toOrigin = new Matrix4().makeTranslation(-geometry.origin[0], -geometry.origin[1], -geometry.origin[2])
  const toGridMm = new Matrix4().makeScale(s0, s1, s2).multiply(indexToLps.invert())
  const centre = new Matrix4().makeTranslation(
    -(rasDimensions[0]! - 1) / 2,
    -(rasDimensions[1]! - 1) / 2,
    -(rasDimensions[2]! - 1) / 2,
  )
  return centre.multiply(toGridMm).multiply(toOrigin)
}

/** Places an object whose vertices are in patient LPS millimetres into the 3D view's world. */
export function placeInPatientFrame(object: Object3D, transform: Matrix4): void {
  object.matrixAutoUpdate = false
  object.matrix.copy(transform)
  object.matrixWorldNeedsUpdate = true
}
