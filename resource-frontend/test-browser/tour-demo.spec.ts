import { expect, test } from '@playwright/test'
import { waitForAllPanels, waitForHydration } from './helpers'

/**
 * Task 10: chapter 3's one camera exemption, proved in a real browser.
 *
 * The unit suite (useTourDirector.test.ts) proves the restore is airtight
 * against faked deps; these prove it against the real CopperStage/OrbitControls
 * wiring, and that theatre mode -- the dimming that makes the exemption
 * legible as "the tour is doing this, not a bug" -- never uses `blur()`.
 *
 * Three-up (1920x1080): the anatomy panel has to be a distinct target from
 * its neighbours for the halo-alignment assertion to mean anything, and the
 * default 1280x720 viewport collapses to one-up (see tour-card-bounds.spec.ts).
 */
test.describe('guided tour demos', () => {
  test('the rotate step moves the camera and then puts it back', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    // Walk to the rotate step by id rather than by pressing Next a fixed
    // number of times, so adding a step to chapter 1 does not break this.
    const cardTitle = page.locator('[data-tour-card] h2')
    for (let i = 0; i < 20; i++) {
      const title = await cardTitle.textContent()
      if (title === 'Rotate the model') break
      await page.locator('[data-tour-next]').click()
    }
    await expect(cardTitle).toHaveText('Rotate the model')

    // The halo must already be over the anatomy panel here -- WHILE the
    // 2500ms orbit demo is still running, not once it finishes. TourLayer
    // paints the target in a pass that runs before the demo starts, so this
    // is a direct read, not a poll: polling for up to the demo's own
    // duration would let a regression that re-introduces the old lag (halo
    // stuck on the previous step's target until the demo ends) pass anyway.
    const halo = await page.locator('[data-tour-halo]').boundingBox()
    const panel = await page.locator('[data-panel="anatomy"]').boundingBox()
    expect(Math.abs(halo!.x - panel!.x)).toBeLessThan(4)
  })

  /**
   * The invariant nothing in this repo was checking: theatre mode must always
   * leave SOMETHING lit.
   *
   * Two steps shipped with targets that sat outside every `[data-tour-region]`
   * -- the case heading and the one-up tab strip -- so no region matched and
   * every one of them dimmed. The reader got the whole app at 30% opacity and
   * `inert`, with the card pointing at something they could barely see. It
   * survived a full review, 620 unit tests and 63 browser tests because every
   * existing assertion checked that dimming HAPPENS (the test below) or that
   * the card is on screen; none checked that the dimming spared anything.
   *
   * Walks all 14 steps, because the two broken ones were 3 and 5 -- a spot
   * check on the first step would have passed.
   */
  test('every step lights something: theatre mode never dims the whole app', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    const card = page.locator('[data-tour-card]')
    await expect(card).toBeVisible()
    // Read the length off the card's own "n / N" counter rather than
    // hardcoding 14, so adding a step extends the walk instead of skipping it.
    const counter = await page.locator('[data-tour-card]').getByText(/^\d+ \/ \d+$/).textContent()
    const total = Number(counter?.split('/')[1]?.trim() ?? 14)
    expect(total).toBeGreaterThan(1)

    /*
     * Read the three facts together in one pass, because they only mean
     * anything together. Polled rather than sampled: a step's demo can still
     * be running when the card's title has already changed.
     *
     * The last step deliberately has NO target -- it is the closing card, and
     * there is nothing left to point at -- so "something must be lit" is the
     * wrong rule. The rule that holds for every step is: if the SPOTLIGHT is
     * pointing at something, a region has to be covering it.
     */
    const verdict = () => page.evaluate(() => {
      const focused = document.querySelectorAll('[data-tour-region][data-tour-focus]').length
      const spotlit = Boolean(document.querySelector('[data-tour-halo]'))
      const nodim = document.body.hasAttribute('data-tour-nodim')
      const usable = document.querySelectorAll('[data-tour-region]:not([inert])').length
      if (usable === 0) return 'every region is inert: the app is unusable'
      if (!nodim && focused === 0) return 'every region is dimmed and nothing is lit'
      if (spotlit && focused === 0) return 'the spotlight points at something no region covers'
      return 'ok'
    })

    for (let i = 0; i < total; i++) {
      const title = await page.locator('[data-tour-card] h2').textContent()
      await expect.poll(verdict, { message: `step ${i + 1} ("${title}")` }).toBe('ok')

      const next = page.locator('[data-tour-next]')
      if (await next.count() === 0) break
      await next.click()
      await page.waitForTimeout(400)
    }
  })

  /**
   * The tour must not leave the viewer displaced once it is over.
   *
   * Reported as "the model and the image are deformed after the guided tour".
   * They were not deformed -- the canvas measured 622x1045 before and after,
   * identically -- the MRI was parked on its LAST slice instead of the one
   * the reader started on. At the last slice the plane sits far closer to the
   * camera than at the middle, so it renders much larger and spills outside
   * the panel, which is what "deformed" looked like.
   *
   * `useTourDirector.test.ts` pins the restore logic directly; this pins the
   * outcome a reader can actually see, after a REAL tour with real
   * auto-advance -- which is what supersedes the scrub step in practice and
   * is the thing no unit test was simulating.
   */
  test('a completed tour leaves every panel where the reader left it', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)

    const readouts = () => page.locator('[data-panel] [data-tour="stage-controls"] p[aria-hidden="true"]')
      .allTextContents()

    // `waitForAllPanels`, not a "does the readout look like n / m" poll. A
    // volume's `max` GROWS as it decodes, so a readout matches that shape
    // long before it settles -- an earlier version of this test compared
    // "9 / 18" against "20 / 39" and failed for that reason alone.
    await waitForAllPanels(page)
    const before = await readouts()

    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    for (let i = 0; i < 20; i++) {
      const next = page.locator('[data-tour-next]')
      if (await next.count() === 0) break
      // 1600ms, not a tighter loop, and the number matters. The scrub demo
      // holds the far end of the volume for its own `durationMs`; advance
      // faster than that and the step is skipped before the demo starts, so
      // the window this test exists for is never entered at all. Verified:
      // at 700ms this test passes even with both restore paths deleted.
      await page.waitForTimeout(1600)
      await next.click().catch(() => {})
    }
    await expect(page.locator('[data-tour-card]')).toHaveCount(0)

    /*
     * Back to the case the "before" reading was taken on, by CLICKING THE
     * SIDEBAR -- the way a reader gets there, and the only way this test
     * means anything. Two traps, both hit while writing it:
     *
     *  - `page.goto` would work but proves nothing: a full reload remounts
     *    every stage and resets the slice by construction, so the test passed
     *    even with both restore paths deleted.
     *  - Escape is not enough either. Running the tour to its END calls
     *    `finishTour`, which deliberately does NOT navigate back (design doc
     *    §4.4), so the reader is left on the lesion case and Escape has
     *    nothing to exit. Comparing there compares two different volumes.
     */
    await page.locator('#case-sidebar a', { hasText: 'The Breast' }).first().click()
    await waitForAllPanels(page)

    await expect.poll(readouts, { timeout: 30_000 }).toEqual(before)
  })

  test('theatre mode dims the other regions and never uses blur', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    await page.locator('[data-tour-next]').click() // -> the sidebar step

    const dimmed = page.locator('#case-content-panel')
    await expect(dimmed).toHaveCSS('opacity', '0.3')
    const filter = await dimmed.evaluate(el => getComputedStyle(el).filter)
    expect(filter).toContain('saturate')
    expect(filter).not.toContain('blur')
  })

  test('Escape restores the app completely', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-tour-card]')).toHaveCount(0)
    await expect(page.locator('body')).not.toHaveAttribute('data-tour-active', /.*/)
    await expect(page.locator('#case-content-panel')).toHaveCSS('opacity', '1')
  })

  /**
   * The MRI volume is 20-30MB and, unlike the anatomy GLB, routinely does
   * not finish loading inside the director's stall/ceiling window in a
   * cold headless run -- exactly the case `bodyFallback` exists for. This
   * asserts what is true either way: the tour reaches the step, names the
   * MRI panel, shows non-empty copy, and never surfaces an app error --
   * not which of the two copy variants won the race.
   */
  test('the slice step reaches the MRI panel and degrades cleanly if the volume is not ready', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    const cardTitle = page.locator('[data-tour-card] h2')
    for (let i = 0; i < 20; i++) {
      const title = await cardTitle.textContent()
      if (title === 'Move through the volume') break
      await page.locator('[data-tour-next]').click()
    }
    await expect(cardTitle).toHaveText('Move through the volume')
    await expect(page.locator('[data-panel="mri"]')).toHaveAttribute('data-focused', 'true')
    await expect(page.locator('[data-tour-card] p').last()).not.toHaveText('')
    await expect(page.getByRole('alert')).toHaveCount(0)

    // Whichever path the step took, moving on must still work.
    await page.locator('[data-tour-next]').click()
    await expect(cardTitle).toHaveText('Per-view controls')
  })

  /**
   * Task 11: the design doc's distinction (§4.4) between finishing and
   * exiting, proved end to end. `waitForHydration` is required here --
   * "Start the guided tour" is AppHeader's server-rendered button, and a
   * click on it before TourLauncher mounts hits inert markup.
   */
  test('finishing leaves the reader on the lesion case; exiting returns them', async ({ page }) => {
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()

    for (let i = 0; i < 25; i++) {
      const title = await page.locator('[data-tour-card] h2').textContent()
      if (title === "That's the tour") break
      await page.locator('[data-tour-next]').click()
    }
    await page.locator('[data-tour-next]').click() // Finish
    await expect(page).toHaveURL(/cancer-ductal/)

    // waitForHydration's own precondition (a fresh context, tour never
    // "seen") no longer holds after finishing above -- restore it so the
    // second half of this test can rely on the same helper.
    await page.evaluate(() => localStorage.removeItem('teuma.tour.seen'))
    await page.goto('/the-breast/anatomy')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Start the guided tour' }).click()
    await page.locator('[data-tour-next]').click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/the-breast/)
  })
})
