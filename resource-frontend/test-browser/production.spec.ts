import { createReadStream, statSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { artefactProblem, artefactsRequired, centreDrawnFraction, focusedPanel, focusedStage, waitForModality } from './helpers'

/**
 * The §12 criteria that can only be measured against what actually ships.
 *
 * The rest of `test-browser/` runs against `yarn dev`, which is right for
 * behaviour and wrong for bytes: Vite serves every dependency unbundled, so
 * `/the-breast` costs 24MB there, 15MB of it copper3d.js and three.module.js
 * in source form. Measuring §12 item 7's 3MB budget against that number
 * would be measuring the dev server, not the app.
 *
 * So this serves `build/` -- the real `yarn build` artefact -- over a static
 * server modelled on the hosts it ships to: every path that is not a file
 * falls back to index.html (nginx's `try_files`, GitHub Pages' 404.html),
 * `/api/` goes to the FastAPI backend on :8082, and the caching and
 * compression are GitHub Pages', measured against the real host on
 * 2026-07-30:
 *
 *   · `Cache-Control: max-age=600` plus an ETag, so caching behaves as it
 *     will in production (`curl -I https://pages.github.com/favicon.ico`).
 *   · gzip for text, which is the difference between passing and failing a
 *     transfer budget: Pages serves `/js/jquery.js` as 33,081 bytes against
 *     93,107 on disk. Without this the §12 item 7 measurement below is
 *     inflated ~2.8x on the JS, which is most of that page's weight.
 *
 * Binary assets (`.wasm`, `.glb`, `.nrrd`, images) are served uncompressed
 * here. Pages may well compress some of them; not modelling that keeps the
 * measured number an UPPER bound, which is the safe side for a budget.
 *
 * SKIPPED when there is no build, rather than failing: `yarn test:browser`
 * has to stay runnable without a build in front of it. Run `yarn build`
 * first to include these.
 *
 * Also carries the PWA checks (client feedback item 1). They started in
 * their own `test-browser/pwa.spec.ts` against `yarn dev`, which turned out
 * to prove nothing: the dev server never emits a real service worker or
 * manifest unless `devOptions` forces one, and a dev-only worker is not the
 * artefact that ships. A PWA is a production artefact, so it belongs in the file that
 * already tests production artefacts.
 */

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../build')
// Clear of this repo's own servers: the dev server on 3158 (also
// docker-compose's default `FRONTEND_PORT`), and the Docker frontend when it
// runs beside the dev server with a `FRONTEND_PORT=3159` override.
const PORT = 4180
const base = `http://localhost:${PORT}`

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
}

/** Text types GitHub Pages gzips. See this file's header for the measurement. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg'])

function findFile(urlPath: string) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0]!)).replace(/^(\.\.[/\\])+/, '')
  // A path with no extension is a route of the single-page app, and every
  // route is index.html -- what nginx's `try_files` does in production.
  const spa = extname(clean) ? [] : [join(PUBLIC_DIR, 'index.html')]
  for (const candidate of [join(PUBLIC_DIR, clean), ...spa]) {
    try {
      const stat = statSync(candidate)
      if (stat.isFile()) return { path: candidate, stat }
    }
    catch { /* try the next candidate */ }
  }
  return null
}

let server: Server | undefined

/** `index.html` rather than the folder: a folder's mtime is not its build time. */
const buildProblem = artefactProblem('build/index.html')

test.describe('§12 acceptance, against the built site', () => {
  test.skip(Boolean(buildProblem) && !artefactsRequired, `${buildProblem} -- run \`yarn test:artefacts\``)

  test.beforeAll(async () => {
    if (buildProblem) throw new Error(`${buildProblem} -- run \`yarn test:artefacts\` (CI or REQUIRE_ARTEFACTS is set, so this fails rather than skips)`)
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/')) {
        // The imaging catalogue, from the backend (see playwright.config.ts).
        const upstream = request({ host: '127.0.0.1', port: 8082, path: req.url, method: req.method, headers: req.headers },
          (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res) })
        upstream.on('error', () => res.writeHead(502).end())
        req.pipe(upstream)
        return
      }
      const found = findFile(req.url ?? '/')
      if (!found) {
        res.writeHead(404).end('not found')
        return
      }
      const ext = extname(found.path)
      const etag = `"${found.stat.size.toString(16)}-${found.stat.mtimeMs.toString(16)}"`
      const headers: Record<string, string> = {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'etag': etag,
        'last-modified': found.stat.mtime.toUTCString(),
        // What GitHub Pages actually sends, measured against
        // https://pages.github.com on 2026-07-30.
        'cache-control': 'max-age=600',
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end()
        return
      }

      const compress = COMPRESSIBLE.has(ext)
        && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
      if (compress) {
        // No content-length: the compressed size is not known until the
        // stream ends, which is also how Pages serves it.
        headers['content-encoding'] = 'gzip'
        res.writeHead(200, headers)
        createReadStream(found.path).pipe(createGzip()).pipe(res)
        return
      }
      headers['content-length'] = String(found.stat.size)
      res.writeHead(200, headers)
      createReadStream(found.path).pipe(res)
    })
    await new Promise<void>(done => server!.listen(PORT, done))
  })

  test.afterAll(async () => {
    // Unset when beforeAll refused a missing or stale artefact.
    if (server) await new Promise<void>(done => server!.close(() => done()))
  })

  test('item 7: the-breast first screen transfers under 3MB', async ({ page }) => {
    // Anatomy first, one Draco GLB, zero NRRD -- design doc §9.2's third
    // row, and the entry point every new reader pays for.
    //
    // Counted over CDP, not from `content-length`. A gzipped response has no
    // content-length (the size is not known until the stream ends), and
    // Playwright's `response.body()` hands back the DECODED bytes -- both
    // roads lead to measuring the wrong number. `loadingFinished`'s
    // `encodedDataLength` is what actually crossed the wire.
    const transferred = new Map<string, number>()
    const urlById = new Map<string, string>()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.requestWillBeSent', e => urlById.set(e.requestId, e.request.url))
    cdp.on('Network.loadingFinished', (e) => {
      const url = urlById.get(e.requestId)
      if (url) transferred.set(url, (transferred.get(url) ?? 0) + e.encodedDataLength)
    })

    // One-up, so the first screen loads one panel's asset. At three-up all
    // three load, which is correct and a different measurement.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/the-breast`)
    await waitForModality(page)

    const total = [...transferred.values()].reduce((a, b) => a + b, 0)
    console.log(`the-breast first screen (production, gzip): ${(total / 1048576).toFixed(2)} MB`)
    for (const [u, n] of [...transferred.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`   ${(n / 1024).toFixed(0).padStart(6)} KB  ${u.replace(base, '')}`)
    }

    expect(
      [...transferred.keys()].filter(u => u.endsWith('.nrrd')),
      'design doc §9.2: the entry point loads no volume',
    ).toEqual([])
    expect(total, 'design doc §12 item 7: first screen under 3MB').toBeLessThan(3 * 1024 * 1024)
  })

  /**
   * A 3D view loads and paints, on the artefact that ships.
   *
   * copper3d 4.1 fetches every NRRD inside a Web Worker started from a
   * `blob:` URL, where a root-relative URL cannot be parsed. `yarn dev` hands
   * it an absolute URL (the backend on :8082), so every dev-server spec
   * passed while this build showed "Couldn't load the 3D viewer" on every
   * imaging modality and never requested a single volume. One volume of
   * each kind -- the 3D MRI and the 3D mammogram -- and one Draco GLB: the
   * build no longer ships three's own decoder files
   * (tooling/three-decoder-defaults.ts), so the anatomy view is what proves
   * the decoder the app does use, `public/draco/`, still loads.
   */
  for (const view of [
    { path: '/density-a/anatomy', asset: /\.glb$/, draco: true },
    { path: '/density-a/mri', asset: /\.nrrd$/, draco: false },
    { path: '/cancer-ductal/mammogram', asset: /\.nrrd$/, draco: false },
  ]) {
    test(`a 3D view loads and paints: ${view.path}`, async ({ page }) => {
      const assets: string[] = []
      const decoder: string[] = []
      page.on('response', (r) => {
        const url = r.url()
        if (view.asset.test(url)) assets.push(`${r.status()} ${url}`)
        if (url.includes('/draco/')) decoder.push(`${r.status()} ${url}`)
      })

      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${base}${view.path}`)
      await waitForModality(page)
      // Healthy means the asset is in the scene: the stage enables Reset
      // only then, and a failed load never gets there.
      await expect(focusedPanel(page).getByRole('button', { name: /reset/i })).toBeEnabled({ timeout: 60_000 })
      await expect.poll(() => centreDrawnFraction(focusedStage(page)), {
        message: 'the stage is healthy but drew nothing',
        timeout: 30_000,
      }).toBeGreaterThan(0.2)
      await expect(page.getByRole('alert')).toHaveCount(0)
      expect(assets.length, 'the view\'s asset was never requested').toBeGreaterThan(0)
      expect(assets.every(a => a.startsWith('200 ')), assets.join('\n')).toBe(true)
      if (view.draco) {
        expect(decoder.length, 'the Draco decoder was never requested').toBeGreaterThan(0)
        expect(decoder.every(d => d.startsWith('200 ')), decoder.join('\n')).toBe(true)
      }
    })
  }

  /**
   * My MRI's volume goes through the same worker, from its own call site.
   *
   * Needs the backend to open the patient dataset (a MinIO at the backend's
   * MINIO_ENDPOINT with the SPARC dataset uploaded). When it cannot, the page shows its own
   * session error and never mounts the viewer -- that is the environment, not
   * the code under test, so the test skips rather than fails.
   */
  test('My MRI loads the scan and paints it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${base}/my-mri`)

    const viewer = page.getByRole('img', { name: 'Your MRI scan in 3D' })
    // The 3D column's session error. The report column has an error state of
    // its own (a local backend cannot render the PDF), which says nothing
    // about the scan, so everything here is scoped to the 3D column.
    const column = page.locator('section', { has: page.getByRole('heading', { name: '3D view' }), hasNot: page.getByRole('heading', { name: 'Report' }) })
    const sessionError = column.locator('[data-state="error"]')
    await expect(viewer.or(sessionError)).toBeVisible({ timeout: 60_000 })
    test.skip(await sessionError.isVisible(), 'the backend could not open the patient dataset (is MINIO_ENDPOINT right?)')

    // Enabled once the volume has loaded and been placed.
    await expect(page.getByRole('button', { name: 'Reset the 3D view' })).toBeEnabled({ timeout: 120_000 })
    await expect(column.getByRole('alert')).toHaveCount(0)
    await expect.poll(() => centreDrawnFraction(viewer), {
      message: 'the viewer is ready but drew no scan',
      timeout: 30_000,
    }).toBeGreaterThan(0.2)
  })

  test('a deep link boots and renders', async ({ page }) => {
    // The fallback path, which nothing else covers: a case URL loaded cold
    // is served index.html, and the app has to resolve the page itself from
    // the address bar -- the failure mode a static host would ship silently.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/density-d/mammogram`)
    await waitForModality(page)
    await expect(focusedPanel(page).getByRole('button', { name: /reset/i }))
      .toBeEnabled({ timeout: 60_000 })
  })

  /**
   * The guided tour, against the artefact GitHub Pages actually publishes.
   *
   * Every other tour spec runs against `yarn dev`, where the app is served
   * unbundled from source. Production serves PREBUILT, MINIFIED, CODE-SPLIT
   * chunks -- differences no other spec exercises. The tour writes
   * `data-tour-active` onto `<body>` before its own overlay renders. If that overlay fails to
   * mount for any reason, the reader is left staring at an app dimmed to 30%
   * opacity with no card, no rail, and no way out -- which is exactly what
   * was reported from the deployed site.
   *
   * So this asserts the two things that failure looks like: the overlay is
   * there while the tour runs, and the dimming is gone once it ends.
   */
  test('the guided tour runs on the built site and never leaves the app dimmed', async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', e => failures.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) {
        failures.push(`console: ${m.text()}`)
      }
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/the-breast/anatomy`)

    // The launcher is `.client`-only, so its arrival is proof this
    // prerendered page has hydrated -- see helpers.ts's waitForHydration.
    const take = page.locator('[data-tour-take]')
    await expect(take).toBeVisible({ timeout: 30_000 })
    await take.click()

    const card = page.locator('[data-tour-card]')
    await expect(card, 'the tour card never rendered on the built site').toBeVisible()
    await expect(page.locator('[data-tour-rail]')).toBeVisible()

    // Walk a few steps, including the ones that navigate. Each iteration
    // re-checks the invariant that matters: while the body is dimmed, the
    // overlay that explains why must be on screen.
    for (let i = 0; i < 5; i++) {
      await expect(page.locator('body[data-tour-active]')).toHaveCount(1)
      await expect(card).toBeVisible()
      await expect(
        page.locator('[data-tour-region][data-tour-focus]'),
        `step ${i}: every region dimmed, so nothing was highlighted`,
      ).not.toHaveCount(0)
      await page.locator('[data-tour-next]').click()
      await page.waitForTimeout(600)
    }

    await page.keyboard.press('Escape')
    await expect(page.locator('body[data-tour-active]')).toHaveCount(0)
    await expect(card).toHaveCount(0)

    expect(failures, `the built site threw while running the tour:\n${failures.join('\n')}`)
      .toEqual([])
  })

  /**
   * The same thing again, but hydrating SLOWLY.
   *
   * The bug this exists for only ever appeared on the deployed site, and only
   * after an empty-cache hard reload. Everything local -- dev server and this
   * generated build alike -- serves its chunks instantly, so hydration was
   * over before anything could race it and the failure never showed.
   *
   * What it was: `TourLayer.client.vue`'s `.client` suffix wrapped it in
   * Nuxt's client-only wrapper, which on a cold hydration re-renders the
   * server's own markup for itself as a static vnode. The server renders
   * nothing for a client-only component, so that vnode owned no DOM node,
   * and the next update ran
   * `patch(prev, next, hostParentNode(prev.el), ...)` against a null `el`.
   * Confirmed by rewriting that exact call site in the shipped chunk and
   * reading back the component name: `TourLayer`, with `[data-tour-layer]`
   * absent from the document entirely. Both tour components are now plain
   * components behind the layout's own mounted gate, so no wrapper is
   * involved at all.
   *
   * Throttling is the closest a local run gets to that, and it is the axis
   * this suite had no coverage on at any tier.
   */
  test('the tour still opens when the page boots under latency', async ({ page }) => {
    const failures: string[] = []
    page.on('pageerror', e => failures.push(`pageerror: ${e.message}`))

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 300,
      downloadThroughput: (1.5 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/the-breast/anatomy`)

    // The gate the layout opens on mount. Its arrival is the whole point:
    // under the old wrapper this element could never appear at all.
    await expect(page.locator('[data-tour-layer]')).toBeAttached({ timeout: 60_000 })

    await page.locator('[data-tour-take]').click({ timeout: 60_000 })
    await expect(page.locator('[data-tour-card]')).toBeVisible({ timeout: 30_000 })

    await page.keyboard.press('Escape')
    await expect(page.locator('body[data-tour-active]')).toHaveCount(0)

    expect(failures, `the built site threw while booting:\n${failures.join('\n')}`).toEqual([])
  })

  /**
   * Client feedback item 1, against the real build. `test/pwa.test.ts`
   * asserts vite.config.ts's `pwaOptions`; these assert what actually
   * shipped -- see this file's header for why that has to be here rather
   * than against `yarn dev`.
   *
   * Dropped from the original design (moved from `test-browser/pwa.spec.ts`):
   * a `navigator.serviceWorker.register()` round-trip inside the page. That
   * is a meaningful check against the real GitHub Pages origin, but this
   * static server has none of the quirks (HTTPS, header mismatches) that a
   * live registration would catch beyond what fetching `sw.js` directly
   * already proves. The failure mode that actually matters here -- imaging
   * assets leaking into the precache -- is fully covered by reading `sw.js`'s
   * own text below, so that is what is asserted instead.
   */
  test('the manifest is served with the fields the client\'s old app had', async ({ page }) => {
    await page.goto(`${base}/the-breast`)

    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBeTruthy()

    const response = await page.request.get(new URL(href!, base).href)
    expect(response.ok()).toBe(true)

    const manifest = await response.json()
    expect(manifest.name).toBe('Breast Educational Resource')
    expect(manifest.short_name).toBe('Breast Education App')
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toContain('512x512')
  })

  test('every icon the manifest declares actually resolves', async ({ page }) => {
    await page.goto(`${base}/the-breast`)
    const href = (await page.locator('link[rel="manifest"]').getAttribute('href'))!
    const manifestUrl = new URL(href, base).href
    const manifest = await (await page.request.get(manifestUrl)).json()

    for (const icon of manifest.icons as { src: string }[]) {
      const url = new URL(icon.src, manifestUrl).href
      const response = await page.request.get(url)
      expect(response.ok(), `${icon.src} -> ${response.status()}`).toBe(true)
    }
  })

  /**
   * The half of the Task 4 -> Task 5 filename contract the manifest test
   * above does not cover. `favicon.ico` and `apple-touch-icon-180x180.png`
   * are never listed in `manifest.icons` -- they are referenced from
   * index.html's own `<link>`s instead (`rel="icon"` and
   * `rel="apple-touch-icon"`), which is a second, independent place a
   * filename has to agree with what Task 4 actually generated. A rename on
   * either side 404s silently: no browser install prompt, no PWA check,
   * fails -- the tab and the home-screen icon just go blank.
   */
  test('the two icons outside the manifest resolve: favicon.ico and apple-touch-icon', async ({ page }) => {
    await page.goto(`${base}/the-breast`)

    const faviconHref = await page.locator('link[rel="icon"]').getAttribute('href')
    const appleHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
    expect(faviconHref, 'no <link rel="icon"> in the served HTML').toBeTruthy()
    expect(appleHref, 'no <link rel="apple-touch-icon"> in the served HTML').toBeTruthy()

    for (const href of [faviconHref!, appleHref!]) {
      const response = await page.request.get(new URL(href, base).href)
      expect(response.ok(), `${href} -> ${response.status()}`).toBe(true)
    }
  })

  test('the service worker script is served and the HTML references the manifest', async ({ page }) => {
    await page.goto(`${base}/the-breast`)
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1)

    // vite-plugin-pwa's default `filename`.
    const response = await page.request.get(`${base}/sw.js`)
    expect(response.ok()).toBe(true)
  })

  /**
   * The load-bearing assertion of this file's PWA coverage. ~355MB of NRRD
   * and GLB must never enter the precache manifest -- see vite.config.ts's
   * `pwaOptions`.
   */
  test('no imaging asset is precached', async ({ page }) => {
    const source = await (await page.request.get(`${base}/sw.js`)).text()
    // The manifest itself, not the whole file: `modelView` legitimately
    // appears in the navigation fallback's denylist, which keeps a direct
    // request for an asset from being answered with the app shell.
    const manifest = source.match(/precacheAndRoute\((\[[\s\S]*?\])\s*,/)?.[1]
    expect(manifest, 'sw.js has a precache manifest').toBeTruthy()
    expect(manifest).not.toMatch(/\.nrrd/)
    expect(manifest).not.toMatch(/\.glb/)
    expect(manifest).not.toMatch(/modelView/)
    expect(source).not.toMatch(/\.nrrd/)
    expect(source).not.toMatch(/\.glb/)
  })

  /**
   * The service worker answers navigations with the app shell -- this is a
   * single-page app, so every route IS index.html, and without the fallback
   * an installed copy could not open a deep link offline.
   *
   * What the Nuxt build's no-fallback rule protected still holds, and is the
   * second half of this test: a mistyped or stale link must fail VISIBLY,
   * never quietly turn into the home page. The shell resolves the path
   * itself and shows the 404 page.
   */
  test('navigations fall back to the app shell, and a wrong link still fails visibly', async ({ page }) => {
    const source = await (await page.request.get(`${base}/sw.js`)).text()
    expect(source).toMatch(/NavigationRoute/)
    expect(source).toMatch(/createHandlerBoundToURL\("index\.html"\)/)

    await page.goto(`${base}/no-such-case`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('404')
    await expect(page.getByText('Page Not Found: /no-such-case').first()).toBeVisible()
  })
})
