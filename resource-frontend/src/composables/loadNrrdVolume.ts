import { absoluteUrl } from './assetUrl'
import type { CopperScene } from './copper-types'

/**
 * The one way this app calls copper3d's `loadNrrd`: same arguments, with the
 * URL made absolute against the page first (see `absoluteUrl` on why the
 * worker that fetches it cannot take anything else).
 *
 * `test/loadNrrdVolume.test.ts` fails if any other file calls `loadNrrd`.
 */
export function loadNrrdVolume(
  scene: Pick<CopperScene, 'loadNrrd'>,
  ...[url, ...rest]: Parameters<CopperScene['loadNrrd']>
): void {
  scene.loadNrrd(absoluteUrl(url, document.baseURI), ...rest)
}
