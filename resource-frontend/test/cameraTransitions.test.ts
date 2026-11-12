import { describe, expect, it } from 'vitest'
import { chooseTransition } from '../src/composables/cameraTransitions'

/** The interpolation math moved into copper3d; its tests went with it, to
 *  `app/ts/__tests__/cameraTransitions.test.ts`. What is left here is the one
 *  part that reads this catalogue's own content. */

describe('chooseTransition (design doc §7.1)', () => {
  const anatomyA = { group: 'density' as const, slug: 'density-a', modality: 'anatomy' as const }
  const anatomyD = { group: 'density' as const, slug: 'density-d', modality: 'anatomy' as const }
  const mriD = { group: 'density' as const, slug: 'density-d', modality: 'mri' as const }
  const anatomyOverview = { group: 'overview' as const, slug: 'the-breast', modality: 'anatomy' as const }
  const mammoDcis = { group: 'cancer' as const, slug: 'cancer-dcis', modality: 'mammogram' as const }

  it('morphs between density levels while on anatomy', () => {
    expect(chooseTransition(anatomyA, anatomyD)).toBe('density-morph')
  })

  it('morphs between the overview and a density level on anatomy', () => {
    expect(chooseTransition(anatomyOverview, anatomyA)).toBe('density-morph')
  })

  it('does not morph when the modality is imaging', () => {
    expect(chooseTransition(mriD, { ...mriD, slug: 'density-a' })).toBe('modality-flight')
  })

  it('does not morph across groups', () => {
    expect(chooseTransition(anatomyD, mammoDcis)).toBe('modality-flight')
  })

  it('flies when only the modality changes', () => {
    expect(chooseTransition(anatomyD, mriD)).toBe('modality-flight')
  })

  it('cuts when nothing changed', () => {
    expect(chooseTransition(anatomyD, anatomyD)).toBe('cut')
  })
})
