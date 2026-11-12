import { describe, expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from '../src/utils/contrast'

describe('relativeLuminance', () => {
  it('returns 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
  })

  it('accepts hex without the leading hash', () => {
    expect(relativeLuminance('FFFFFF')).toBeCloseTo(1, 5)
  })
})

describe('contrastRatio', () => {
  it('returns 21 for black on white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1)
  })

  it('is symmetric', () => {
    expect(contrastRatio('#D94F70', '#FFFFFF'))
      .toBeCloseTo(contrastRatio('#FFFFFF', '#D94F70'), 5)
  })

  it('returns 1 for identical colours', () => {
    expect(contrastRatio('#F7F8FA', '#F7F8FA')).toBeCloseTo(1, 5)
  })

  // The two bands the palette is built on, exercised here as literals so
  // this file still tests the function rather than the stylesheet
  // (tokens.test.ts reads the real tokens). Deep Burgundy is the ink;
  // Breast Rose is the accent that is not allowed to be one.
  it('scores the brand ink above the AA body-text floor', () => {
    expect(contrastRatio('#8E3650', '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })

  it('scores the brand rose below the AA body-text floor but over the 3:1 graphics floor', () => {
    expect(contrastRatio('#D94F70', '#FFFFFF')).toBeLessThan(4.5)
    expect(contrastRatio('#D94F70', '#FFFFFF')).toBeGreaterThanOrEqual(3)
  })
})
