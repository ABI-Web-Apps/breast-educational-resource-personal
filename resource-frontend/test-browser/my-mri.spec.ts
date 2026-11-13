import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { centreDrawnFraction } from './helpers'

/**
 * My MRI end to end: the sidebar entry, the 3D view with its colour key, and
 * the report column.
 *
 * Needs MinIO with the patient dataset uploaded to `measurements/workdir`, so
 * it runs only when MY_MRI_E2E=1. The base URL defaults to the Docker stack
 * (http://localhost:3159); point MY_MRI_BASE_URL at the dev server and set
 * MY_MRI_BACKEND=local to run against a local uvicorn, which cannot render
 * the report PDF (WeasyPrint needs the Docker image's system libraries).
 */
test.skip(process.env.MY_MRI_E2E !== '1', 'needs MinIO with the dataset; set MY_MRI_E2E=1')

const localBackend = process.env.MY_MRI_BACKEND === 'local'

test.use({
  baseURL: process.env.MY_MRI_BASE_URL ?? 'http://localhost:3159',
  viewport: { width: 1440, height: 900 },
})

test.describe('My MRI', () => {
  test('opens from the sidebar with the scan and the report', async ({ page }) => {
    const report = page.waitForResponse(res => /\/api\/patients\/[^/]+\/[^/]+\/report\.pdf/.test(res.url()), { timeout: 120_000 })

    await page.goto('/')
    await page.getByRole('link', { name: /My MRI/ }).first().click()

    await expect(page.getByRole('heading', { level: 1, name: 'Your MRI scan' })).toBeVisible()
    await expect(page.getByText(/^Patient .+ · contrast phase 1$/)).toBeVisible()

    const viewer = page.getByRole('img', { name: 'Your MRI scan in 3D' })
    await expect(viewer.locator('canvas')).toHaveCount(1, { timeout: 120_000 })
    await expect(page.getByRole('button', { name: /reset the 3d view/i })).toBeEnabled({ timeout: 120_000 })
    await expect.poll(() => centreDrawnFraction(viewer, { background: 'left-edge' }), {
      message: 'the 3D view is ready but drew nothing',
      timeout: 30_000,
    }).toBeGreaterThan(0.05)

    const key = page.getByRole('list', { name: 'Colour key' })
    await expect(key.getByText('Finding 1')).toBeVisible()
    await expect(key.getByText('Finding 2')).toBeVisible()

    const res = await report
    if (localBackend) {
      expect(res.status()).toBe(503)
      await expect(page.getByText('Report rendering needs the Docker backend.')).toBeVisible()
    } else {
      expect(res.status()).toBe(200)
      // Headless Chromium has no PDF viewer, so the report shows as links
      // rather than an iframe.
      await expect(page.getByRole('link', { name: 'Open report' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Download' })).toBeVisible()
    }
  })

  // The trackball's own wheel listener is on the canvas: only a real browser
  // shows whether a scroll moves the slice or the camera.
  test('a single view scrolls through its slices; Ctrl+scroll zooms instead', async ({ page }) => {
    await page.goto('/my-mri')
    const viewer = page.getByRole('img', { name: 'Your MRI scan in 3D' })
    await expect(page.getByRole('button', { name: /reset the 3d view/i })).toBeEnabled({ timeout: 120_000 })
    const views = page.getByRole('group', { name: 'View' })
    const readout = page.locator('[aria-live="polite"]')
    await expect(readout).toHaveCount(0)

    await views.getByRole('button', { name: 'Axial', exact: true }).click()
    await expect(views.getByRole('button', { name: 'Axial', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const sliceOf = async () => Number(/Slice (\d+) \/ \d+/.exec(await readout.innerText())![1])
    const start = await sliceOf()
    const box = (await viewer.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 100)
    await expect.poll(sliceOf).toBe(start + 5)
    expect(await centreDrawnFraction(viewer, { background: 'left-edge' }), 'the single view drew nothing')
      .toBeGreaterThan(0.05)

    // The slice stays put, so any change on the stage is the camera moving.
    const before = await viewer.screenshot()
    await page.keyboard.down('Control')
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect.poll(async () => !(await viewer.screenshot()).equals(before), { message: 'Ctrl+scroll did not zoom' })
      .toBe(true)
    expect(await sliceOf()).toBe(start + 5)

    await page.getByRole('button', { name: /reset the 3d view/i }).click()
    await expect(views.getByRole('button', { name: '3D', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(readout).toHaveCount(0)
  })

  // a11y.spec.ts runs without the dataset, so My MRI's own controls are scanned
  // here, with a single view open: the pressed view button and the slice readout.
  test('has no serious or critical axe violations with a single view open', async ({ page }) => {
    await page.goto('/my-mri')
    await expect(page.getByRole('button', { name: /reset the 3d view/i })).toBeEnabled({ timeout: 120_000 })
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Coronal', exact: true }).click()
    await expect(page.locator('[aria-live="polite"]')).toHaveText(/^Slice \d+ \/ \d+$/)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
    const blocking = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')
    expect(blocking.map(v => `${v.impact}/${v.id} on ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
  })

  test('going to a case and back does not stack a second canvas', async ({ page }) => {
    await page.goto('/my-mri')
    const viewer = page.getByRole('img', { name: 'Your MRI scan in 3D' })
    await expect(viewer.locator('canvas')).toHaveCount(1, { timeout: 120_000 })

    await page.getByRole('link', { name: 'Density A' }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Your MRI scan' })).toBeHidden()

    await page.getByRole('link', { name: /My MRI/ }).first().click()
    await expect(page.getByRole('heading', { level: 1, name: 'Your MRI scan' })).toBeVisible()
    await expect(viewer.locator('canvas')).toHaveCount(1)
    await expect(page.locator('canvas')).toHaveCount(1)
  })
})
