import { createReadStream, statSync } from 'node:fs'
import { createServer, request, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { artefactProblem, artefactsRequired, centreDrawnFraction, focusedPanel, focusedStage, waitForModality } from './helpers'

/**
 * The UMD bundle the portal mounts (`yarn build:plugin` -> `dist/`), mounted
 * the way the portal mounts it.
 *
 * Everything else in `test-browser/` loads the standalone app. The plugin is a
 * different artefact: one UMD file, built in library mode, evaluated by a
 * `<script>` element on a page that is not its own, with Vue and Pinia
 * supplied as globals. Two regressions only ever showed here:
 *
 *   - the bundle threw while evaluating (`new URL(<asset>, import.meta.url)`
 *     with an empty `import.meta` -- see `BUNDLE_URL` in vite.config.ts), so
 *     the plugin's global was never defined and the portal had nothing to
 *     mount;
 *   - every volume failed in copper3d's `blob:` worker, which cannot resolve
 *     the plugin's root-relative API URLs (see `absoluteUrl`).
 *
 * Portal-shaped paths, from `RemoteComponentApp.vue` and the workspace
 * CLAUDE.md: the page lives elsewhere than the bundle (so `document.baseURI`
 * is not the bundle's folder), the bundle and its `public/` files under
 * `/tools/<expose>/primary/`, and the backend ONLY under
 * `/plugin/<expose>/api/`. The portal's builder always sets
 * `VITE_PLUGIN_ROUTE_PREFIX`, so a bundle built without it is not the
 * artefact that ships: its bare `/api/` requests are refused and reported.
 * `yarn test:artefacts` builds it with a prefix.
 *
 * Skipped when `dist/my-app.umd.js` is missing or older than the source, and
 * failed instead under CI or REQUIRE_ARTEFACTS -- see `artefactProblem`.
 */

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const NODE_MODULES = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules')
const PORT = 4181
const base = `http://localhost:${PORT}`
const GLOBAL = 'BreastEducationalResource'

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const HOST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>portal</title></head>
<body style="margin:0"><div id="app" style="height:100vh"></div>
<script src="/vendor/vue.js"></script>
<script src="/vendor/pinia.js"></script>
<script src="/tools/ber/primary/my-app.umd.js?v=1"></script>
<script>
  const app = Vue.createApp(window.${GLOBAL})
  app.use(Pinia.createPinia())
  app.mount('#app')
</script>
</body></html>`

function sendFile(res: ServerResponse, path: string) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('not a file')
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': String(stat.size) })
    createReadStream(path).pipe(res)
  }
  catch {
    res.writeHead(404).end()
  }
}

/** Requests that reached for `/api/` without the route prefix. */
const strayApi: string[] = []

/** Records every response whose URL matches `pattern`, as `<status> <url>`. */
function responses(page: Page, pattern: RegExp): string[] {
  const seen: string[] = []
  page.on('response', (r) => { if (pattern.test(r.url())) seen.push(`${r.status()} ${r.url()}`) })
  return seen
}

function expectAll200(seen: string[], what: string) {
  expect(seen.length, `${what} was never requested`).toBeGreaterThan(0)
  expect(seen.every(s => s.startsWith('200 ')), seen.join('\n')).toBe(true)
}

let server: Server | undefined
const distProblem = artefactProblem('dist/my-app.umd.js')

test.describe('the plugin bundle, mounted as the portal mounts it', () => {
  test.skip(Boolean(distProblem) && !artefactsRequired, `${distProblem} -- run \`yarn test:artefacts\``)

  test.beforeAll(async () => {
    if (distProblem) throw new Error(`${distProblem} -- run \`yarn test:artefacts\` (CI or REQUIRE_ARTEFACTS is set, so this fails rather than skips)`)
    server = createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!
      const prefixed = url.match(/^\/plugin\/[^/]+(\/api\/.*)$/)
      if (prefixed) {
        // The backend, as the portal's generated nginx location proxies it.
        const query = req.url!.includes('?') ? req.url!.slice(req.url!.indexOf('?')) : ''
        const upstream = request({ host: '127.0.0.1', port: 8082, path: prefixed[1]! + query, method: req.method, headers: req.headers },
          (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res) })
        upstream.on('error', () => res.writeHead(502).end())
        req.pipe(upstream)
        return
      }
      if (url.startsWith('/api/')) {
        strayApi.push(url)
        res.writeHead(404).end('no backend at /api/ -- the portal serves it under /plugin/<expose>/api/')
        return
      }
      if (url === '/vendor/vue.js') return sendFile(res, join(NODE_MODULES, 'vue/dist/vue.global.prod.js'))
      if (url === '/vendor/pinia.js') return sendFile(res, join(NODE_MODULES, 'pinia/dist/pinia.iife.prod.js'))
      if (url.startsWith('/tools/ber/primary/')) {
        const rel = normalize(decodeURIComponent(url.slice('/tools/ber/primary/'.length))).replace(/^(\.\.[/\\])+/, '')
        return sendFile(res, join(DIST, rel))
      }
      if (url.startsWith('/portal/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HOST_PAGE)
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>(done => server!.listen(PORT, done))
  })

  test.afterAll(async () => {
    // Unset when beforeAll refused a missing or stale artefact.
    if (server) await new Promise<void>(done => server!.close(() => done()))
  })

  test.beforeEach(() => { strayApi.length = 0 })
  test.afterEach(() => {
    expect(strayApi, 'requests to /api/ without the route prefix: dist/ was built without VITE_PLUGIN_ROUTE_PREFIX -- run `yarn test:artefacts`')
      .toEqual([])
  })

  test('the bundle evaluates, defines its global and mounts', async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', e => failures.push(e.message))

    // `load` fires after every classic script has run, so an error thrown
    // while the bundle evaluated has been reported by the time this returns.
    await page.goto(`${base}/portal/tools/ber`)
    expect(failures, `the bundle threw:\n${failures.join('\n')}`).toEqual([])
    expect(await page.evaluate(name => typeof (window as unknown as Record<string, unknown>)[name], GLOBAL)).toBe('object')
    await expect(page.getByRole('link', { name: 'Density A' }).first()).toBeVisible({ timeout: 30_000 })
  })

  /** Opens Density A's `tab` (the plugin routes in memory, so the address
   *  bar cannot deep-link) and waits for it to paint. */
  async function openAndPaint(page: Page, tab: string) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/portal/tools/ber`)
    await page.getByRole('link', { name: 'Density A' }).first().click({ timeout: 30_000 })
    await page.getByRole('link', { name: tab, exact: true }).first().click()

    await waitForModality(page)
    await expect(focusedPanel(page).getByRole('button', { name: /reset/i })).toBeEnabled({ timeout: 60_000 })
    await expect.poll(() => centreDrawnFraction(focusedStage(page)), {
      message: 'the stage is healthy but drew nothing',
      timeout: 30_000,
    }).toBeGreaterThan(0.2)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }

  test('a Draco GLB decodes and paints inside the mounted plugin', async ({ page }) => {
    const models = responses(page, /\/plugin\/[^/]+\/api\/.*\.glb$/)
    const decoder = responses(page, /\/tools\/ber\/primary\/draco\//)
    await openAndPaint(page, 'Anatomy')
    expectAll200(models, 'the anatomy model')
    expectAll200(decoder, 'the Draco decoder (from the bundle\'s own draco/)')
  })

  test('an imaging volume loads and paints inside the mounted plugin', async ({ page }) => {
    const volumes = responses(page, /\/plugin\/[^/]+\/api\/.*\.nrrd$/)
    await openAndPaint(page, 'MRI')
    expectAll200(volumes, 'the volume')
  })
})
