/**
 * Old site route -> new route (design doc §4.5).
 * Source: `generate.routes` in frontend/nuxt.config.js.
 * These paths may be bookmarked or linked externally and must stay reachable.
 *
 * This is the only place this table exists. The app's route table
 * (navigation/routes.ts) resolves it on every navigation, replacing the
 * address bar's path with the new one -- the job the Nuxt build's
 * `routeRules` redirect stubs did at build time.
 */
export const LEGACY_ROUTES: Record<string, string> = {
  '/model-breast': '/the-breast',
  '/density-1': '/density-a',
  '/density-2': '/density-b',
  '/density-3': '/density-c',
  '/density-4': '/density-d',
}

/**
 * The five lesion cases are deliberately absent from the table above.
 *
 * Case pages used to live under `/case/<slug>`; they are now served at
 * `/<slug>` directly (the human's #9: why does this app's routing carry a
 * `case` segment at all -- it reads oddly). For `benign-cyst`,
 * `benign-fibroadenoma`, `cancer-dcis`,
 * `cancer-lobular` and `cancer-ductal` the legacy path and the new path are
 * now the SAME string, so a redirect entry for them would be a rule pointing
 * at itself -- a loop in the router and a `<meta http-equiv="refresh">`
 * pointing at its own page in the generated stub.
 *
 * They still resolve, because the real route now answers on that path. Only
 * the five paths whose names actually changed need a redirect.
 */
export const LEGACY_ROUTES_SERVED_DIRECTLY = [
  '/benign-cyst',
  '/benign-fibroadenoma',
  '/cancer-dcis',
  '/cancer-lobular',
  '/cancer-ductal',
] as const
