import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { waitForHydration } from './helpers'

/**
 * Task 12: accessibility and graceful-degradation acceptance for the guided
 * tour. Four things most likely to be quietly broken by a later change:
 * axe compliance while the tour is running, modal focus management,
 * keyboard stepping, and the stalled-volume / reduced-motion fallback copy.
 *
 * `waitForHydration` is required before every click on `[data-tour-open]`,
 * AppHeader's server-rendered button -- see helpers.ts for why a click
 * before hydration is silently lost.
 */
test.describe('guided tour accessibility', () => {
  test('introduces no axe violations while running', async ({ page }) => {
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    await expect(page.locator('[data-tour-card]')).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('moves focus into the card and returns it to the opener on exit', async ({ page }) => {
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    const opener = page.getByRole('button', { name: 'Start the guided tour' })
    await opener.click()
    await expect(page.locator('[data-tour-card]')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
  })

  test('arrow keys step the tour', async ({ page }) => {
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    const first = await page.locator('[data-tour-card] h2').textContent()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-tour-card] h2')).not.toHaveText(first!)
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('[data-tour-card] h2')).toHaveText(first!)
  })

  test('degrades to manual copy when the volume never arrives', async ({ page }) => {
    // Hang every NRRD so the MRI stage can never become ready.
    await page.route('**/*.nrrd', () => { /* never fulfilled */ })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    for (let i = 0; i < 25; i++) {
      const title = await page.locator('[data-tour-card] h2').textContent()
      if (title === 'Move through the volume') break
      await page.locator('[data-tour-next]').click()
    }
    // The fallback copy, not the demo copy, and the tour is still walkable.
    await expect(page.locator('[data-tour-card]')).toContainText('Drag up and down')
    await page.locator('[data-tour-next]').click()
    await expect(page.locator('[data-tour-card]')).toBeVisible()
  })

  test('under reduced motion nothing animates and the manual copy is shown', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    for (let i = 0; i < 25; i++) {
      const title = await page.locator('[data-tour-card] h2').textContent()
      if (title === 'Rotate the model') break
      await page.locator('[data-tour-next]').click()
    }
    await expect(page.locator('[data-tour-card]')).toContainText('Drag the anatomy model')
  })

  /**
   * `[data-tour="locate-lesion"]` is `v-if="hasLesion"` in StageControls.vue,
   * which requires a loaded volume -- exactly what is missing when this step
   * degrades. The fallback copy must describe what will happen once the MRI
   * loads, not instruct pressing a button that is not on screen.
   */
  test('locate fallback copy does not send the reader after an absent control', async ({ page }) => {
    await page.route('**/*.nrrd', () => { /* never fulfilled */ })
    await page.goto('/cancer-ductal/mri')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    // Jump straight to the lesion chapter -- no need to also stall out
    // chapter 3's slice step on the way there.
    await page.locator('[data-tour-chapter="lesion"]').click()
    const cardTitle = page.locator('[data-tour-card] h2')
    await expect(cardTitle).toHaveText('A case with a lesion')
    await page.locator('[data-tour-next]').click()
    await expect(cardTitle).toHaveText('Find the lesion')

    const card = page.locator('[data-tour-card]')
    await expect(card).not.toContainText('Press Locate lesion')
    await expect(card).toContainText('Once this case\'s MRI has finished loading')
  })
})
