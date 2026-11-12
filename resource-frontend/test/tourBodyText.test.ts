import { describe, expect, it } from 'vitest'
import { tourStepBody } from '../src/utils/tourBodyText'

const STEP = { body: 'demo copy', bodyFallback: 'manual copy' }

describe('tourStepBody', () => {
  it('shows the demo copy while playing', () => {
    expect(tourStepBody('playing', STEP)).toBe('demo copy')
  })

  it('shows the fallback copy once the stage has failed', () => {
    expect(tourStepBody('fallback', STEP)).toBe('manual copy')
  })

  // I1: 'waiting' used to fall through to the demo copy, so the card lied
  // ("this one is stepping through them") for up to the 60s ceiling while
  // nothing was actually stepping through anything.
  it('shows the fallback copy while waiting on a slow stage, not the demo copy', () => {
    expect(tourStepBody('waiting', STEP)).toBe('manual copy')
  })

  it('falls back to the demo copy if a step has no fallback text at all', () => {
    expect(tourStepBody('waiting', { body: 'only copy', bodyFallback: undefined })).toBe('only copy')
  })

  it('returns empty string for no step', () => {
    expect(tourStepBody('playing', undefined)).toBe('')
  })
})
