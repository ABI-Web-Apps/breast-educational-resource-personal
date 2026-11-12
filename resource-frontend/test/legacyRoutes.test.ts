import { describe, expect, it } from 'vitest'
import { enabledCases } from '../src/content/cases'
import { LEGACY_ROUTES, LEGACY_ROUTES_SERVED_DIRECTLY } from '../src/content/legacyRoutes'
import { resolveFinal, resolvePath } from '../src/navigation/routes'

describe('legacy route table (design doc §4.5)', () => {
  /**
   * Every legacy path must still resolve -- but not all of them by
   * REDIRECTING. Case pages moved from `/case/<slug>` to `/<slug>`, so five
   * of the ten legacy paths are now the real route's own path and a redirect
   * entry for them would point at itself. Those five are declared in
   * `LEGACY_ROUTES_SERVED_DIRECTLY`.
   */
  it('covers the ten paths the old site generated', () => {
    const covered = [...Object.keys(LEGACY_ROUTES), ...LEGACY_ROUTES_SERVED_DIRECTLY]
    expect(covered).toHaveLength(10)
    expect(new Set(covered).size).toBe(10)
  })

  it('no legacy path is both redirected and served directly', () => {
    for (const path of LEGACY_ROUTES_SERVED_DIRECTLY) {
      expect(Object.keys(LEGACY_ROUTES)).not.toContain(path)
    }
  })

  it('every redirect target resolves to an enabled case, and is not a self-loop', () => {
    const slugs = new Set(enabledCases().map(c => c.slug))
    for (const [from, target] of Object.entries(LEGACY_ROUTES)) {
      expect(slugs.has(target.replace(/^\//, ''))).toBe(true)
      expect(target).not.toBe(from)
    }
  })

  it('every directly-served legacy path is an enabled case slug', () => {
    const slugs = new Set(enabledCases().map(c => c.slug))
    for (const path of LEGACY_ROUTES_SERVED_DIRECTLY) {
      expect(slugs.has(path.replace(/^\//, ''))).toBe(true)
    }
  })

  /**
   * Nuxt turned this table into `routeRules` redirects at build time. With
   * no server-side pages any more, the app's own route table does it, on
   * every navigation -- so every legacy path must still land on its case.
   */
  it('the route table redirects every legacy path to its case', () => {
    for (const [from, target] of Object.entries(LEGACY_ROUTES)) {
      expect(resolvePath(from)).toEqual({ redirect: target })
      expect(resolveFinal(from).route).toMatchObject({ name: 'case', path: target })
    }
  })

  it('the route table serves every directly-served legacy path as a case page', () => {
    for (const path of LEGACY_ROUTES_SERVED_DIRECTLY) {
      expect(resolvePath(path)).toMatchObject({ route: { name: 'case', path } })
    }
  })
})
