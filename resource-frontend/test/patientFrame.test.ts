import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { VolumeGeometry } from 'copper3d'
import { placeInPatientFrame, worldFromLps } from '../src/myMri/patientFrame'

/**
 * Ported from the validator's `test/components/viewer/patientFrame.spec.ts`,
 * for the two functions this app uses. The validator's body-box helpers
 * (`worldFromGridMm`, `worldBoxOfVoxels`, `centreSliceIndex`) frame on a box its
 * backend measures; this app frames on the planes and has no such box.
 */

/** Where three puts the plane of slice `index` along an axis (Volume.extractPerpendicularPlane). */
const planePosition = (index: number, spacing: number, ras: number) => index * spacing - (ras - 1) / 2

function lpsOf(geometry: VolumeGeometry, index: number[]): THREE.Vector3 {
  const [d0, d1, d2] = geometry.directions
  return new THREE.Vector3(...[0, 1, 2].map(x =>
    geometry.origin[x]! + index[0]! * d0[x]! + index[1]! * d1[x]! + index[2]! * d2[x]!) as [number, number, number])
}

function rasDimensionsOf(geometry: VolumeGeometry) {
  return geometry.dims.map((n, a) => Math.floor(n * Math.hypot(...geometry.directions[a]!)))
}

const AXIS_ALIGNED: VolumeGeometry = {
  dims: [384, 384, 104],
  directions: [[0.885, 0, 0], [0, 0.885, 0], [0, 0, 1.5]],
  origin: [-175.54, -159.94, -84.44],
}

const a = (10 * Math.PI) / 180
const OBLIQUE: VolumeGeometry = {
  dims: [200, 160, 60],
  directions: [[Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 2]],
  origin: [-90, -70, -59],
}

describe('worldFromLps', () => {
  it.each([['an axis-aligned volume', AXIS_ALIGNED], ['a 10-degree oblique volume', OBLIQUE]] as const)(
    'puts every voxel centre of %s exactly on its slice planes',
    (_name, geometry) => {
      const ras = rasDimensionsOf(geometry)
      const transform = worldFromLps(geometry, ras)
      const spacing = geometry.directions.map(d => Math.hypot(...d))
      for (const index of [[0, 0, 0], [10, 20, 30], [geometry.dims[0] - 1, geometry.dims[1] - 1, geometry.dims[2] - 1]]) {
        const world = lpsOf(geometry, index).applyMatrix4(transform)
        expect(world.x).toBeCloseTo(planePosition(index[0]!, spacing[0]!, ras[0]!), 9)
        expect(world.y).toBeCloseTo(planePosition(index[1]!, spacing[1]!, ras[1]!), 9)
        expect(world.z).toBeCloseTo(planePosition(index[2]!, spacing[2]!, ras[2]!), 9)
      }
    },
  )

  it('for an axis-aligned volume is the old translation, without its half-millimetre error', () => {
    const ras = rasDimensionsOf(AXIS_ALIGNED)
    const transform = worldFromLps(AXIS_ALIGNED, ras)
    const p = new THREE.Vector3(12.3, -45.6, 7.8)
    const oldBias = AXIS_ALIGNED.origin.map((o, x) => -(o * 2 + ras[x]!) / 2)
    const world = p.clone().applyMatrix4(transform)
    ;[world.x, world.y, world.z].forEach((w, x) => expect(w).toBeCloseTo(p.getComponent(x) + oldBias[x]! + 0.5, 9))
  })
})

describe('placeInPatientFrame', () => {
  it('makes the object\'s world matrix the transform, and keeps it there', () => {
    const object = new THREE.Group()
    const transform = worldFromLps(OBLIQUE, rasDimensionsOf(OBLIQUE))
    placeInPatientFrame(object, transform)
    object.updateMatrixWorld()
    expect(object.matrixWorld.elements).toEqual(transform.elements)
    // A later automatic update must not overwrite it from position/rotation/scale.
    object.updateMatrixWorld(true)
    expect(object.matrixWorld.elements).toEqual(transform.elements)
  })
})
