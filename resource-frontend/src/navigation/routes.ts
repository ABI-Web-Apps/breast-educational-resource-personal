import { getCase } from '@/content/cases'
import { LEGACY_ROUTES } from '@/content/legacyRoutes'
import { hasBackend } from '@/runtime/env'

/**
 * The app's page table, without a router library.
 *
 * The portal mounts this app as a plugin inside its own Vue app, and that app
 * owns `vue-router` and the address bar. So pages are chosen here, from a
 * path string, and nothing in this file touches `window.history` -- see
 * `router.ts` for the one place that does, and only outside plugin mode.
 *
 * The table is the old Nuxt `pages/` directory, rule for rule:
 *
 *   /                      -> redirect to /the-breast (pages/index.vue)
 *   LEGACY_ROUTES          -> redirect (nuxt.config.ts's routeRules)
 *   /about                 -> about (pages/about.vue)
 *   /my-mri                -> the patient's own scan and report (404 in a
 *                             build without a backend, see `hasBackend`)
 *   /:slug                 -> case, when the slug names an enabled case
 *   /:slug/:modality       -> case; an unknown modality falls back inside
 *                             the page, exactly as `[[modality]].vue` did
 *   anything else          -> 404 (the page's `validate` guard)
 */

export type PageName = 'case' | 'about' | 'my-mri' | 'not-found'

export interface PageRoute {
  /** Normalised: no query, no hash, no trailing slash (except `/`). */
  path: string
  name: PageName
  params: { slug?: string, modality?: string }
}

export type Resolution = { redirect: string } | { route: PageRoute }

/** Where `/` sends the reader. */
export const HOME_PATH = '/the-breast'

/** Strips query and hash, decodes, and drops a trailing slash. */
export function normalisePath(raw: string): string {
  let path = raw.split(/[?#]/)[0] || '/'
  try { path = decodeURI(path) }
  catch { /* malformed escape: keep it as typed, it will 404 */ }
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/'
  return path
}

export function resolvePath(raw: string): Resolution {
  const path = normalisePath(raw)

  if (path === '/') return { redirect: HOME_PATH }
  const legacy = LEGACY_ROUTES[path]
  if (legacy) return { redirect: legacy }

  const segments = path.slice(1).split('/')

  // vue-router matches static segments case-insensitively by default.
  if (segments.length === 1 && segments[0]!.toLowerCase() === 'about') {
    return { route: { path, name: 'about', params: {} } }
  }

  // A build without a backend (GitHub Pages) cannot serve it; the path 404s there.
  if (hasBackend() && segments.length === 1 && segments[0]!.toLowerCase() === 'my-mri') {
    return { route: { path, name: 'my-mri', params: {} } }
  }

  if (segments.length <= 2 && segments.every(Boolean)) {
    const [slug, modality] = segments as [string, string | undefined]
    const found = getCase(slug)
    if (found && !found.disabled) {
      return { route: { path, name: 'case', params: { slug, modality } } }
    }
  }

  return { route: { path, name: 'not-found', params: {} } }
}

/** Follows redirects to a page. Bounded, so a bad table cannot spin. */
export function resolveFinal(raw: string): { route: PageRoute, redirected: boolean } {
  let resolution = resolvePath(raw)
  let redirected = false
  for (let hops = 0; 'redirect' in resolution && hops < 5; hops++) {
    resolution = resolvePath(resolution.redirect)
    redirected = true
  }
  if ('redirect' in resolution) {
    return { route: { path: normalisePath(raw), name: 'not-found', params: {} }, redirected }
  }
  return { route: resolution.route, redirected }
}
