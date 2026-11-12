import { describe, expect, it } from 'vitest'
import { tourDwellMs } from '../src/utils/tourDwell'

describe('tourDwellMs', () => {
  it('floors an empty/near-empty step at 4000ms', () => {
    expect(tourDwellMs('')).toBe(4000)
    // 6 words -> 2200 + 1560 = 3760, below the floor.
    expect(tourDwellMs('one two three four five six')).toBe(4000)
  })

  it('scales with word count once above the floor', () => {
    // 10 words -> 2200 + 2600 = 4800.
    const body = Array.from({ length: 10 }, (_, i) => `word${i}`).join(' ')
    expect(tourDwellMs(body)).toBe(4800)
  })

  it('caps a long step at 12000ms', () => {
    const body = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    expect(tourDwellMs(body)).toBe(12000)
  })

  it('collapses repeated whitespace instead of counting empty tokens as words', () => {
    expect(tourDwellMs('  one   two  ')).toBe(tourDwellMs('one two'))
  })
})
