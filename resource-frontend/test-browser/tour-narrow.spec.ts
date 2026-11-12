import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { waitForHydration } from './helpers'

/**
 * THE STRUCTURAL GAP: no browser spec in this branch ran below 1280px before
 * this fix wave -- exactly why B2 (the case-nav drawer never closing) and I3
 * (expandSheet doing nothing below xl) survived twelve per-task reviews.
 * `tour-card-bounds.spec.ts`'s "one-up (1280x720)" is still AT the xl
 * breakpoint (Tailwind's default), not below it.
 *
 * Walks all four chapters -- all 14 steps, every layout -- at phone width
 * (390x844) and tablet width (834x1112) by CLICKING `[data-tour-next]`.
 * A click that actually lands is itself proof nothing dimmed/scrimmed is
 * covering the card: Playwright's own actionability check fails the whole
 * test if a click target is obscured, which is exactly what B2's leaked
 * drawer scrim used to do to steps 3-14.
 */
async function assertCardInViewport(page: Page, label: string) {
  const card = page.locator('[data-tour-card]')
  await expect(card, `no card visible at "${label}"`).toBeVisible()
  const box = await card.boundingBox()
  expect(box, `no bounding box for the card at "${label}"`).not.toBeNull()
  const vw = page.viewportSize()!.width
  const vh = page.viewportSize()!.height
  expect(box!.x, `${label}: card's left edge is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${label}: card's top edge is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${label}: card's right edge overflows the viewport`).toBeLessThanOrEqual(vw)
  expect(box!.y + box!.height, `${label}: card's bottom edge overflows the viewport`).toBeLessThanOrEqual(vh)
}

/**
 * B1's guard, checked end to end: a halo, when present at all, must have
 * real size. Before the fix, a target resolved from a `display:none`
 * element (a one-up layout's non-focused panel) still passed
 * TourSpotlight's `v-if="rect"` and drew a breathing dot at the viewport
 * origin -- a DOMRect(0,0,0,0) is truthy.
 */
async function assertHaloSaneIfPresent(page: Page, label: string) {
  const halo = page.locator('[data-tour-halo]')
  if (await halo.count() === 0) return
  const box = await halo.boundingBox()
  expect(box, `${label}: halo has no bounding box`).not.toBeNull()
  expect(box!.width, `${label}: halo has zero width`).toBeGreaterThan(0)
  expect(box!.height, `${label}: halo has zero height`).toBeGreaterThan(0)
}

async function walkWholeTour(page: Page, viewport: { width: number, height: number }) {
  await page.setViewportSize(viewport)
  await page.goto('/the-breast/anatomy')
  await waitForHydration(page)
  await page.locator('[data-tour-open]').click()

  const cardTitle = page.locator('[data-tour-card] h2')
  await expect(cardTitle).toBeVisible()

  // All 14 steps apply to narrow layouts too (tourSteps('narrow').length ===
  // tourSteps('wide').length === 14 -- see tour-content.test.ts).
  for (let i = 1; i <= 14; i++) {
    const title = (await cardTitle.textContent())?.trim() ?? `(step ${i})`
    const label = `step ${i} ("${title}")`
    await assertCardInViewport(page, label)
    await assertHaloSaneIfPresent(page, label)

    // B2: case-list (step 2) opens the below-xl case-nav drawer + scrim;
    // case-heading (step 3) must already have closed it, or the scrim sits
    // over every later step and the click below fails outright.
    if (i >= 3) {
      await expect(
        page.locator('button[aria-label="Close case navigation"]'),
        `${label}: sidebar scrim still open`,
      ).toHaveCount(0)
    }

    if (i < 14) await page.locator('[data-tour-next]').click()
  }
  await expect(cardTitle).toHaveText('That\'s the tour')
}

test.describe('guided tour at narrow viewports', () => {
  test('walks all 14 steps, on-screen and clickable throughout, at phone width (390x844)', async ({ page }) => {
    await walkWholeTour(page, { width: 390, height: 844 })
  })

  test('walks all 14 steps, on-screen and clickable throughout, at tablet width (834x1112)', async ({ page }) => {
    await walkWholeTour(page, { width: 834, height: 1112 })
  })

  /**
   * I3: the `description` step must actually expand the tablet's bottom
   * sheet. `viewer.contentOpen` has no consumer below xl (see
   * stores/viewer.ts) -- a fix that only touched that field would leave the
   * sheet frozen at its 80px peek, which the step's own halo would then
   * spotlight without the reader being able to see any of the description
   * it names.
   */
  test('the description step expands the tablet bottom sheet (834x1112)', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1112 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.locator('[data-tour-open]').click()

    const cardTitle = page.locator('[data-tour-card] h2')
    for (let i = 0; i < 14; i++) {
      if ((await cardTitle.textContent())?.trim() === 'The description') break
      await page.locator('[data-tour-next]').click()
    }
    await expect(cardTitle).toHaveText('The description')
    // The handle's label flips to "Collapse..." only once sheetExpanded is
    // true -- see default.vue.
    await expect(page.getByRole('button', { name: 'Collapse content panel' })).toBeVisible()
  })
})
