import * as Copper from 'copper3d'

/**
 * The one place copper3d is imported.
 *
 * Until copper3d 3.9.0 this file also carried a `document.currentScript` shim:
 * the bundle inlined a webpack runtime (for the sensor plugin it vendored)
 * that resolved its public path at MODULE EVALUATION time, so under native ESM
 * -- where `currentScript` is always null -- `import "copper3d"` threw
 * `Automatic publicPath is not supported in this browser` before a single line
 * of the library ran. 3.9.0 loads that plugin on demand instead, so a plain
 * static import works and the shim is gone.
 *
 * The module is kept behind `loadCopper3d()` rather than imported directly at
 * each call site so the tests have one seam to replace -- see
 * `useCopperStage.test.ts`.
 */

export type Copper3d = typeof Copper

/** Async purely to keep `useCopperStage`'s mount hook unchanged. */
export function loadCopper3d(): Promise<Copper3d> {
  return Promise.resolve(Copper)
}

export function copper3d(): Copper3d {
  return Copper
}
