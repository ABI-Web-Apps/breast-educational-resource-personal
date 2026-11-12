import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTourStages, getTourStage, registerTourStage, unregisterTourStage,
} from '../src/composables/useTourStageBridge'
import type { TourStageApi } from '../src/composables/useTourStageBridge'

function fakeStage(overrides: Partial<TourStageApi> = {}): TourStageApi {
  return {
    isReady: () => true,
    isFailed: () => false,
    snapshot: () => ({ position: [0, 0, 1], up: [0, 1, 0], target: [0, 0, 0] }),
    applyPose: vi.fn(),
    orbit: vi.fn(async () => {}),
    scrubTo: vi.fn(),
    sliceMax: () => 100,
    loadProgress: () => 1,
    lesionSliceIndex: () => 62,
    locate: vi.fn(),
    reset: vi.fn(),
    prefersReducedMotion: () => false,
    ...overrides,
  }
}

describe('tour stage bridge', () => {
  beforeEach(() => clearTourStages())

  it('returns undefined for a panel that never registered', () => {
    expect(getTourStage('mri')).toBeUndefined()
  })

  it('hands back exactly what was registered, per panel', () => {
    const anatomy = fakeStage({ sliceMax: () => 0 })
    const mri = fakeStage()
    registerTourStage('anatomy', anatomy)
    registerTourStage('mri', mri)
    expect(getTourStage('anatomy')!.sliceMax()).toBe(0)
    expect(getTourStage('mri')!.sliceMax()).toBe(100)
  })

  it('unregister removes only that panel', () => {
    registerTourStage('anatomy', fakeStage())
    registerTourStage('mri', fakeStage())
    unregisterTourStage('anatomy')
    expect(getTourStage('anatomy')).toBeUndefined()
    expect(getTourStage('mri')).toBeDefined()
  })

  it('re-registering the same panel replaces the previous entry', () => {
    registerTourStage('mri', fakeStage({ sliceMax: () => 1 }))
    registerTourStage('mri', fakeStage({ sliceMax: () => 2 }))
    expect(getTourStage('mri')!.sliceMax()).toBe(2)
  })
})
