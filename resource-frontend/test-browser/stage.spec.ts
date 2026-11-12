import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { focusedStage, waitForAllPanels, waitForModality } from './helpers'

/**
 * The first tests on this branch that actually run copper3d.
 *
 * What each assertion is worth is stated where it is made. The point of
 * being explicit is that these tests are the ONLY evidence the 3D core
 * works at all -- a test here that quietly proves less than it appears to
 * would be worse than no test, because it would retire a risk that is
 * still live.
 */

/**
 * Proves a real WebGL context exists on the canvas copper3d created, by
 * asking the canvas itself rather than by inferring it from the DOM.
 *
 * `getContext` returns the EXISTING context when one has already been
 * created, so this observes copper3d's own context and cannot manufacture
 * a passing result by creating a second one: a canvas that copper3d never
 * initialised returns a fresh context whose `drawingBufferWidth` is the
 * untouched default, which the size assertion below rejects.
 *
 * Scoped to the FOCUSED panel: three are mounted, and the two hidden ones
 * hold a context whose drawing buffer is whatever they last measured.
 */
async function webglReport(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-panel][data-focused="true"] canvas',
    )
    if (!canvas) return { present: false as const }
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return { present: true as const, context: null }
    return {
      present: true as const,
      context: {
        version: gl.getParameter(gl.VERSION) as string,
        renderer: gl.getParameter(gl.RENDERER) as string,
        error: gl.getError(),
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
      },
    }
  })
}

/**
 * The fraction of the stage's pixels that differ from its own background.
 *
 * This is the assertion that catches "the stage is there, the asset loaded,
 * and it drew nothing". Two earlier versions of it did not:
 *
 * - PNG byte length. Worthless: the stage carries a CSS gradient
 *   background, so a screenshot of a completely blank stage sailed past
 *   any threshold. It reported the NRRD path as healthy while every
 *   imaging modality in the app rendered solid black.
 * - `drawImage` from the live WebGL canvas. Always zero: without
 *   `preserveDrawingBuffer` the drawing buffer is cleared once composited,
 *   so it reported a stage we had visually confirmed as working as blank.
 *
 * A Playwright element screenshot captures the composited result, which is
 * what a human would see. The reference colour is the stage's own top-left
 * pixel -- background under every modality, since all content is centred --
 * so this works against both the light anatomy backdrop and the dark film
 * one without hard-coding either.
 */
async function drawnFraction(page: Page): Promise<number> {
  const png = PNG.sync.read(await focusedStage(page).screenshot())
  const { data, width, height } = png
  const [br, bg, bb] = [data[0], data[1], data[2]]

  let drawn = 0
  for (let i = 0; i < data.length; i += 4) {
    // Manhattan distance from the background, comfortably above the
    // gradient's own top-to-bottom drift and any SwiftShader dithering.
    if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 30) {
      drawn++
    }
  }
  return drawn / (width * height)
}

test.describe('3D stage', () => {
  // Reported rather than asserted: a WebGL warning is normal under
  // SwiftShader, but a copper3d or three error here would explain any
  // failure below far faster than the assertion message would.
  const consoleErrors: string[] = []
  test.beforeEach(async ({ page }) => {
    consoleErrors.length = 0
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  })

  test('renders the anatomy GLB in a real WebGL context', async ({ page }) => {
    await page.goto('/density-a')
    await waitForModality(page)

    const report = await webglReport(page)
    expect(report.present, 'copper3d appended no canvas to the stage host').toBe(true)
    expect(report.context, 'the canvas has no WebGL context').not.toBeNull()
    expect(report.context!.width).toBeGreaterThan(0)
    expect(report.context!.height).toBeGreaterThan(0)
    expect(report.context!.error, 'WebGL reported an error code').toBe(0)

    expect(await drawnFraction(page), "the stage rendered nothing").toBeGreaterThan(0.01)

    console.log('WebGL:', report.context!.version, '|', report.context!.renderer)
    if (consoleErrors.length) console.log('console errors:', consoleErrors)
  })

  test('decodes and renders an NRRD volume', async ({ page }) => {
    // density-4 carries this catalogue's smallest volume (10.9MB) and is
    // still a full decode-and-upload of the real shipped asset.
    await page.goto('/density-d/mammogram')
    await waitForModality(page)

    const report = await webglReport(page)
    expect(report.context, 'the canvas has no WebGL context').not.toBeNull()
    expect(report.context!.error).toBe(0)
    expect(await drawnFraction(page), "the stage rendered nothing").toBeGreaterThan(0.01)

    if (consoleErrors.length) console.log('console errors:', consoleErrors)
  })

  test('keeps one canvas per panel across a modality switch', async ({ page }) => {
    // Design doc §8.2 -- "switch the scene, not the renderer". A fourth
    // canvas here means a renderer was rebuilt, which is the leak
    // app.vue's page key exists to prevent. Three, not one: three-up mounts
    // a stage per panel and never unmounts one, which is what stops a
    // revisited panel reloading.
    await page.goto('/density-d')
    await waitForModality(page)
    await expect(page.locator('[data-panel] canvas')).toHaveCount(3)

    await page.getByRole('link', { name: /^Mammogram$/i }).click()
    await waitForModality(page)

    await expect(page.locator('[data-panel] canvas')).toHaveCount(3)
    if (consoleErrors.length) console.log('console errors:', consoleErrors)
  })

  /**
   * Client feedback item 5. Leaving a case and coming back must not
   * re-download its volume. Before the page key became a constant, this
   * downloaded ~10MB twice.
   *
   * Navigates via the sidebar's own links, NOT `page.goto`: a `goto` is a
   * full document load that rebuilds every renderer from scratch, which is
   * a different thing entirely and is not what a reader stepping through
   * the sidebar does -- it would defeat the point of this test.
   *
   * Snapshots with `waitForAllPanels`, not `waitForModality`: staged
   * loading (CasePanels' `released` latch) means the two non-focused panels
   * start their own downloads in the background once the focused one
   * settles, which can still be in flight the instant `waitForModality`'s
   * narrower, focused-only wait resolves. Waiting for all three closes that
   * race and makes each snapshot a true "nothing left in flight" point --
   * incidentally also checking the non-focused panels don't re-download,
   * which is a strictly stronger version of the same assertion.
   */
  test('returning to a case does not re-download its volume', async ({ page }) => {
    const volumeRequests: string[] = []
    page.on('request', (request) => {
      if (/\.nrrd(\?|$)/.test(request.url())) volumeRequests.push(request.url())
    })

    await page.goto('/cancer-ductal/mammogram')
    await waitForAllPanels(page)
    const afterFirst = volumeRequests.length
    expect(afterFirst).toBeGreaterThan(0)

    // Scoped to the sidebar: the prev/next cards name the current case too,
    // and this test is specifically about the sidebar's own navigation.
    const sidebar = page.locator('#case-sidebar')
    await sidebar.getByRole('link', { name: 'Fibroadenoma' }).click()
    await waitForAllPanels(page)

    const beforeReturn = volumeRequests.length
    await sidebar.getByRole('link', { name: 'Ductal' }).click()
    await waitForAllPanels(page)

    expect(volumeRequests.length).toBe(beforeReturn)
    if (consoleErrors.length) console.log('console errors:', consoleErrors)
  })
})
