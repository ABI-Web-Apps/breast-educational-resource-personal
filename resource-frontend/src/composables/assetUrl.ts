/**
 * Joins an asset URL (design doc §9.2). `base` comes from `assetBase()`
 * (runtime/env.ts):
 *   - the backend -> "<api base>/modelView/"
 *   - GitHub Pages -> "/<repo>/modelView/"
 *   - external object storage -> "https://.../"
 */
export function assetUrl(path: string, base: string): string {
  if (!path) throw new Error('assetUrl received an empty path')
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * `url` resolved against `base` -- at a call site, `document.baseURI`, which
 * is what a `fetch` on the page itself would have resolved it against.
 *
 * Required for every URL handed to copper3d's `loadNrrd` -- which is why
 * `loadNrrdVolume` is the only caller of it. Since 4.1 `loadNrrd`
 * fetches the volume inside a Web Worker started from a `blob:` URL, and a
 * worker resolves `fetch` against its own URL: nothing relative can be parsed
 * against `blob:`, so the worker throws "Failed to parse URL" before any
 * request goes out. The standalone and plugin builds' API base is
 * root-relative (`/api`, `/plugin/<expose>/api`), so every volume failed
 * there, while `yarn dev`'s absolute `http://localhost:8082/api` hid it.
 */
export function absoluteUrl(url: string, base: string): string {
  return new URL(url, base).href
}

/**
 * Prefixes a root-relative asset base with the app's own base path
 * (Vite's `base`, set via `APP_BASE_URL` for a GitHub Pages subpath
 * deploy per design doc §8.5). Without this, a subpath deploy
 * with the default `assetBase` of "/modelView/" would request assets from
 * the site root instead of "/<subpath>/modelView/", 404ing everything.
 *
 * Absolute bases (an external CDN/object store) are returned untouched --
 * they are never served under this app's own path.
 */
export function resolveAssetBase(assetBase: string, appBaseURL: string): string {
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(assetBase)) return assetBase
  const prefix = appBaseURL.replace(/\/+$/, '')
  if (!prefix) return assetBase
  return `${prefix}/${assetBase.replace(/^\/+/, '')}`
}

/**
 * A file served straight out of `public/`, base-path aware.
 *
 * Distinct from `assetUrl` because `assetBase` is specifically the IMAGING
 * base -- `/modelView/` locally, and potentially an external object store.
 * Team portraits and partner logos are neither: they are small, they always
 * ship with the app, and routing them through `assetBase` would ask an
 * object store for `/modelView/team/...` and 404.
 *
 * `appBaseURL` still applies, for the same GitHub Pages subpath reason.
 */
export function publicUrl(path: string, appBaseURL: string): string {
  if (!path) throw new Error('publicUrl received an empty path')
  const prefix = appBaseURL.replace(/\/+$/, '')
  return `${prefix}/${path.replace(/^\/+/, '')}`
}
