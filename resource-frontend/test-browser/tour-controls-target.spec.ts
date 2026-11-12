import { expect, test } from '@playwright/test'
import { waitForAllPanels } from './helpers'

/**
 * B1: `[data-tour="stage-controls"]` exists on every panel's bar (three-up
 * renders three). Before the fix the `controls` step's selector was
 * unscoped and `resolveTarget` always returned the FIRST DOM match -- the
 * anatomy panel's bar -- regardless of which panel was actually focused,
 * even though the copy ("jump straight to the lesion") only makes sense for
 * the one actually showing that control.
 *
 * Does not assume which panel ends up focused: chapter 3's own `rotate` and
 * `slices` steps refocus the anatomy and then the MRI panel on the way to
 * `controls` (via their own `prepare: focusPanel`), so by the time this step
 * is reached the focused panel is MRI, not whatever the reader started on.
 * What matters is that the halo follows whichever panel IS focused, and, in
 * particular, is never anatomy's bar just because it is first in the DOM.
 */
test('the controls step targets the FOCUSED panel\'s control bar, not always the anatomy one', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/the-breast/mammogram')
  await waitForAllPanels(page)

  await page.locator('[data-tour-open]').click()
  const cardTitle = page.locator('[data-tour-card] h2')
  for (let i = 0; i < 20; i++) {
    if ((await cardTitle.textContent())?.trim() === 'Per-view controls') break
    await page.locator('[data-tour-next]').click()
  }
  await expect(cardTitle).toHaveText('Per-view controls')

  const focusedPanelId = await page.locator('[data-panel][data-focused="true"]').getAttribute('data-panel')
  // The rotate/slices steps' own prepare actions land on MRI by this point
  // -- asserted so a change to that choreography does not silently turn
  // this into a no-op test that happens to always compare against anatomy.
  expect(focusedPanelId).not.toBe('anatomy')

  const halo = await page.locator('[data-tour-halo]').boundingBox()
  const focusedControls = await page
    .locator(`[data-panel="${focusedPanelId}"] [data-tour="stage-controls"]`)
    .boundingBox()
  const anatomyControls = await page
    .locator('[data-panel="anatomy"] [data-tour="stage-controls"]')
    .boundingBox()

  expect(halo, 'halo has no bounding box').not.toBeNull()
  expect(focusedControls, 'focused panel\'s control bar has no bounding box').not.toBeNull()
  expect(anatomyControls, 'anatomy control bar has no bounding box').not.toBeNull()
  expect(Math.abs(halo!.x - focusedControls!.x)).toBeLessThan(4)
  expect(Math.abs(halo!.y - focusedControls!.y)).toBeLessThan(4)
  // Distinct panels at three-up: if the old unscoped selector regressed,
  // the halo would sit over anatomy's bar regardless of who is focused.
  expect(Math.abs(halo!.x - anatomyControls!.x)).toBeGreaterThan(10)
})
