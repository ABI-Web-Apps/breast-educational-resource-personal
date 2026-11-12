import { describe, expect, it } from 'vitest'
import { casePageKey } from '../src/utils/pageKey'
import { enabledCases } from '../src/content/cases'

describe('casePageKey', () => {
  it('gives every case the same key, so the stages survive case navigation', () => {
    const keys = new Set(enabledCases().map(c => casePageKey(c.slug)))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBeTypeOf('string')
  })

  it('returns undefined for a slug that is not a case, so the route path is used', () => {
    expect(casePageKey('nope')).toBeUndefined()
  })

  it('returns undefined when there is no slug param at all', () => {
    expect(casePageKey(undefined)).toBeUndefined()
  })
})
