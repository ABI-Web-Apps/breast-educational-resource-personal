import { expect, test } from '@playwright/test'
import { focusedPanel, panel, waitForAllPanels, waitForModality } from './helpers'

/**
 * Client feedback item 6: three panels side by side when there is room, the
 * one-at-a-time strip when there is not.
 *
 * Nothing in the unit suite can settle any of this -- happy-dom has no
 * layout, so it cannot evaluate a container query, and a hidden element
 * measuring 0x0 is the entire load gate.
 *
 * The threshold is the STAGE COLUMN's width, not the viewport's, so these
 * widths are chosen against the real chrome: sidebar 240px + content panel
 * 400px, leaving the column at viewport - 640.
 */

/** Column ≈ 1280px: three-up. */
const WIDE = { width: 1920, height: 1000 }
/** Column ≈ 640px: one-up. */
const NARROW = { width: 1280, height: 800 }

test.describe('three-up', () => {
  test('lays three panels out side by side when the column is wide enough', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/cancer-ductal')
    await waitForModality(page)

    const boxes = await page.locator('[data-panel]').evaluateAll(els =>
      els.map(el => el.getBoundingClientRect()).map(r => ({ x: r.x, width: r.width })),
    )
    expect(boxes).toHaveLength(3)
    for (const b of boxes) expect(b.width, 'a panel collapsed').toBeGreaterThan(200)
    // Side by side, not stacked: strictly increasing left edges.
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x)
    expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x)

    // The one-up strip would name the same three things a second time.
    await expect(page.getByRole('list', { name: 'Imaging modalities' })).toBeHidden()
  })

  test('falls back to one panel at a time when the column is narrow', async ({ page }) => {
    await page.setViewportSize(NARROW)
    await page.goto('/cancer-ductal')
    await waitForModality(page)

    await expect(page.locator('[data-panel]')).toHaveCount(3)
    // Mounted but not shown -- which is what keeps their renderers alive.
    await expect(page.locator('[data-panel]:visible')).toHaveCount(1)
    await expect(focusedPanel(page)).toBeVisible()
    await expect(page.getByRole('list', { name: 'Imaging modalities' })).toBeVisible()
  })

  /**
   * The load gate. A hidden panel measures 0x0, `CopperStage` never flips
   * `everSized`, and no asset is fetched -- which is what keeps the entry
   * point under §12 item 7's budget even though three stages are mounted.
   */
  test('a hidden panel loads nothing until it is shown', async ({ page }) => {
    const volumes: string[] = []
    page.on('request', (r) => {
      if (/\.nrrd(\?|$)/.test(r.url())) volumes.push(r.url())
    })

    await page.setViewportSize(NARROW)
    await page.goto('/cancer-ductal/anatomy')
    await waitForModality(page)
    await page.waitForTimeout(2000)
    expect(volumes, 'a hidden imaging panel fetched its volume').toEqual([])

    // Widening reveals the other two, and the ResizeObserver that reports a
    // real box is what releases the gate.
    await page.setViewportSize(WIDE)
    await expect(panel(page, 'mammogram').locator('canvas')).toBeVisible()
    await expect
      .poll(() => volumes.length, { timeout: 120_000, message: 'shown panels never loaded' })
      .toBeGreaterThan(0)
  })

  /**
   * Client feedback item 5, at three-up. Stepping to another case and back
   * must not re-fetch anything: scenes are keyed by ASSET, and the renderers
   * are never unmounted.
   */
  test('returning to a case re-fetches nothing', async ({ page }) => {
    const assets: string[] = []
    page.on('request', (r) => {
      if (/\.(nrrd|glb)(\?|$)/.test(r.url())) assets.push(r.url())
    })

    await page.setViewportSize(WIDE)
    await page.goto('/cancer-ductal')
    // All three, not just the focused one: at three-up the other two are
    // still downloading when `waitForModality` returns, and their
    // responses would land inside the count sampled below.
    await waitForAllPanels(page)
    expect(assets.length).toBeGreaterThan(0)

    // Scoped to the sidebar: the prev/next cards carry the same case names.
    const sidebar = page.locator('#case-sidebar')
    await sidebar.getByRole('link', { name: 'Lobular' }).click()
    await waitForAllPanels(page)
    const beforeReturn = assets.length

    await sidebar.getByRole('link', { name: 'Ductal' }).click()
    await waitForAllPanels(page)
    await page.waitForTimeout(2000)

    expect(assets.length, `re-fetched: ${assets.slice(beforeReturn).join(', ')}`)
      .toBe(beforeReturn)
  })

  /**
   * The focused panel is remembered across cases: the reader who picked MRI
   * on one density grade lands on MRI on the next, rather than back on
   * anatomy four times over.
   */
  test('remembers which panel was focused when the case changes', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/density-a')
    await waitForModality(page)
    await expect(panel(page, 'anatomy')).toHaveAttribute('data-focused', 'true')

    await panel(page, 'mri').locator('canvas').click({ position: { x: 5, y: 5 } })
    await expect(page).toHaveURL(/\/density-a\/mri/)
    await expect(panel(page, 'mri')).toHaveAttribute('data-focused', 'true')

    // Scoped to the sidebar: the next card names the same case, and it
    // carries a modality, which is exactly what this test must not use --
    // only a bare `/density-b` falls back to the remembered slot.
    await page.locator('#case-sidebar').getByRole('link', { name: 'Density B' }).click()
    await expect(page).toHaveURL(/\/density-b/)
    await expect(panel(page, 'mri'), 'the focused panel was not remembered')
      .toHaveAttribute('data-focused', 'true')
  })

  /**
   * Client feedback: "when you click the next panel button, would be great
   * to go to the next panel ... then the only thing the person needs to do
   * is to press next". The unit suite pins where each card points; this
   * pins that pressing it moves the focus, and that the walk carries on
   * into the next case.
   */
  test('pressing next steps through the panels, then into the next case', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/density-a/anatomy')
    await waitForModality(page)

    const next = page.getByRole('navigation', { name: 'Previous and next view' })
      .getByRole('link').last()

    await next.click()
    await expect(page).toHaveURL(/\/density-a\/mammogram/)
    await expect(panel(page, 'mammogram')).toHaveAttribute('data-focused', 'true')

    await next.click()
    await expect(page).toHaveURL(/\/density-a\/mri/)
    await expect(panel(page, 'mri')).toHaveAttribute('data-focused', 'true')

    // Off the end of the case: the next case's first slot, not the next
    // case's remembered one.
    await next.click()
    await expect(page).toHaveURL(/\/density-b\/anatomy/)
    await expect(panel(page, 'anatomy')).toHaveAttribute('data-focused', 'true')
  })

  /**
   * Client feedback item 6's second half: a slot holding both a 3D and a 2D
   * view switches between them rather than laying both out, and opens on 3D.
   */
  test('a two-modality slot toggles instead of expanding', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/benign-cyst')
    await waitForModality(page)

    const mammogram = panel(page, 'mammogram')
    const variants = mammogram.locator('[data-variant] button')
    await expect(variants).toHaveCount(2)
    // 3D first (content/cases.ts puts it at modalities[0]).
    await expect(variants.first()).toHaveAttribute('aria-pressed', 'true')

    await variants.nth(1).click()
    await expect(page).toHaveURL(/\/benign-cyst\/ultrasound/)
    await expect(variants.nth(1)).toHaveAttribute('aria-pressed', 'true')
    // Still one canvas in that slot: a toggle, not a second panel.
    await expect(mammogram.locator('canvas')).toHaveCount(1)
    await expect(page.locator('[data-panel]')).toHaveCount(3)
  })

  /**
   * Client feedback: coming back from /about must not reload anything.
   * `app.keepalive` keeps the case page's component instance -- and the
   * three renderers inside it -- alive while another route is on screen.
   */
  test('a trip to /about does not cost a reload', async ({ page }) => {
    const assets: string[] = []
    page.on('request', (r) => {
      if (/\.(nrrd|glb)(\?|$)/.test(r.url())) assets.push(r.url())
    })

    await page.setViewportSize(NARROW)
    await page.goto('/density-d/mammogram')
    await waitForModality(page)
    const afterLoad = assets.length
    expect(afterLoad).toBeGreaterThan(0)

    // The header's link, not the sidebar's partner-logo block, which also
    // points at /about.
    await page.locator('header').getByRole('link', { name: 'About', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible()

    // History back, NOT About's own "Back to the resource" link: that one
    // points at `/`, which redirects to `/the-breast` -- a different case,
    // whose assets are a legitimate new download.
    await page.goBack()
    await expect(page).toHaveURL(/\/density-d\/mammogram/)
    await waitForModality(page)
    await page.waitForTimeout(2000)

    expect(assets.length, `re-fetched after /about: ${assets.slice(afterLoad).join(', ')}`)
      .toBe(afterLoad)
  })
})
