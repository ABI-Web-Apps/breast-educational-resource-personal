import { expect, test } from '@playwright/test'
import { waitForAllPanels } from './helpers'

/**
 * Task 9: chapter 2's one choreographed demo actually moves focus.
 *
 * The unit suite proves `runDemo`/`focusPanelByRoute` are wired correctly
 * against faked deps; only a real browser proves the navigation actually
 * lands -- URL change, `data-focused` flip, and the description column
 * that follows the URL (CasePanels.vue) all in concert.
 */
test('chapter 2 focus step moves focus from anatomy to mammogram', async ({ page }) => {
  // Wide enough that the stage column clears CasePanels' 1000px container
  // threshold with the sidebar and content column both open (the default
  // 1280px viewport does not -- see acceptance.spec.ts's note on the same
  // threshold). Below it, the focus demo's `requiresStage: 'mammogram'`
  // legitimately degrades: a one-up layout keeps non-focused panels at
  // display:none, and CopperStage never begins loading a 0x0 host.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/the-breast/anatomy')
  // All three panels load concurrently at this width, so mammogram's stage
  // is ready before the tour ever asks for it.
  await waitForAllPanels(page)

  await page.locator('[data-tour-open]').click()

  const cardTitle = page.locator('[data-tour-card] h2')
  await expect(cardTitle).toBeVisible()

  // Step through with the keyboard, not the card's own Next button: a wide
  // target rect (chapter 1's "every case lives here" / "three views" steps
  // span almost the full viewport) can place the card below the fold, where
  // Playwright's click refuses to scroll a `position: fixed` element into
  // view. ArrowRight reaches the same `next()` through TourLayer's window
  // keydown listener regardless of where the card landed.
  for (let i = 0; i < 20; i++) {
    if ((await cardTitle.textContent())?.trim() === 'The highlighted view') break
    await page.keyboard.press('ArrowRight')
  }
  await expect(cardTitle).toHaveText('The highlighted view')

  // The demo navigates -- URL now names the mammogram modality.
  await expect(page).toHaveURL(/\/the-breast\/mammogram$/)
  // ... and the mammogram panel carries the focus the URL grants it.
  await expect(page.locator('[data-panel="mammogram"]')).toHaveAttribute('data-focused', 'true')
})
