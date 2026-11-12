import { assetBase, publicBase } from '@/runtime/env'
import { assetUrl, publicUrl } from './assetUrl'

export function useAssetUrl() {
  // `assetBase()` already resolves a root-relative override against the
  // deployment base, so a subpath deploy cannot 404 every asset by asking
  // the site root for them. See `resolveAssetBase`.
  const base = assetBase()
  const appBase = publicBase()
  return {
    /** Imaging assets (NRRD volumes, GLB models, view presets). */
    url: (path: string) => assetUrl(path, base),
    /** Anything else in `public/` -- team portraits, partner logos. See
     * `publicUrl` on why these must not go through the imaging base. */
    publicUrl: (path: string) => publicUrl(path, appBase),
  }
}
