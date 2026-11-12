import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { waitForAllPanels } from './helpers'

/**
 * Fix round 1 (Task 9): a card whose Next button lands off-screen is
 * unreachable to a mouse user, and the earlier `tour-chapter2.spec.ts` used
 * `ArrowRight` to sidestep exactly that, which hid the bug instead of
 * catching it. This walks chapters 1 and 2 -- the seven steps every layout
 * shares, since exactly one of `panels-wide`/`panels-narrow` is included
 * per layout and the other chapter-2 steps carry no `layout` at all -- by
 * CLICKING `[data-tour-next]`, and asserts the card's full box sits inside
 * the viewport at every step. Run at both a wide (three-up) and a narrow
 * (one-up) viewport, since TourCard's placement math depends on the target
 * rects the current layout produces, not just on viewport size in the
 * abstract.
 */
async function assertCardInViewport(page: Page, stepLabel: string) {
  const card = page.locator('[data-tour-card]')
  await expect(card, `no card visible at "${stepLabel}"`).toBeVisible()
  const box = await card.boundingBox()
  expect(box, `no bounding box for the card at "${stepLabel}"`).not.toBeNull()
  const vw = page.viewportSize()!.width
  const vh = page.viewportSize()!.height
  expect(box!.x, `${stepLabel}: card's left edge is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${stepLabel}: card's top edge is off-screen`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${stepLabel}: card's right edge overflows the viewport`).toBeLessThanOrEqual(vw)
  expect(box!.y + box!.height, `${stepLabel}: card's bottom edge overflows the viewport`).toBeLessThanOrEqual(vh)
}

async function walkChapters1And2(page: Page, viewport: { width: number, height: number }) {
  await page.setViewportSize(viewport)
  await page.goto('/the-breast/anatomy')
  await waitForAllPanels(page)

  await page.locator('[data-tour-open]').click()

  const cardTitle = page.locator('[data-tour-card] h2')
  await expect(cardTitle).toBeVisible()

  // Chapters 1 and 2 are exactly seven steps at every layout: welcome,
  // case-list, case-heading, about, panels-{wide,narrow}, focus,
  // description. Click through all seven, checking bounds at each.
  for (let i = 1; i <= 7; i++) {
    const title = (await cardTitle.textContent())?.trim() ?? '(no title)'
    await assertCardInViewport(page, `step ${i} ("${title}")`)
    if (i < 7) await page.locator('[data-tour-next]').click()
  }

  // The walk should have actually reached the description step, not
  // stalled early -- confirms the seven-step count above is still right.
  await expect(cardTitle).toHaveText('The description')
}

test('chapters 1-2 stay clickable and on-screen at three-up (1920x1080)', async ({ page }) => {
  await walkChapters1And2(page, { width: 1920, height: 1080 })
})

test('chapters 1-2 stay clickable and on-screen at one-up (1280x720)', async ({ page }) => {
  await walkChapters1And2(page, { width: 1280, height: 720 })
})
