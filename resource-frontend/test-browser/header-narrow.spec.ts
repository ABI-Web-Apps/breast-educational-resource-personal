import { expect, test } from '@playwright/test'

/**
 * The wordmark has to fit the header it is in.
 *
 * This can only be a browser test. happy-dom has no layout engine, so no
 * unit test in this repo can tell how many lines "Breast Educational
 * Resource" breaks onto or how tall that makes its container -- the same
 * blind spot that let the guided tour's card render off-screen.
 *
 * What was wrong: at 14px the title needs about 160px to set on two lines,
 * and the wordmark was given 90px at 360 and 120px at 390. It broke onto
 * THREE lines, which with the "TE UMA" overline above it filled or exceeded
 * the 56px header. The fix is a type step below 420px plus width reclaimed
 * from the header's own padding, its gaps, and (below 360px) the About
 * glyph. The label never goes: it is what makes About a control a reader
 * can name.
 *
 * 320px is included deliberately -- it is the narrowest viewport the app
 * claims to support, and it is where every one of those measures is needed
 * at once.
 */
const WIDTHS = [320, 360, 375, 390, 414, 430]

for (const width of WIDTHS) {
  test(`the wordmark fits inside the header at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/the-breast/anatomy')

    const header = page.locator('header').first()
    await expect(header).toBeVisible()

    const box = await page.evaluate(() => {
      const head = document.querySelector('header')!
      const mark = head.querySelector('a[href="/"]')!
      const title = mark.querySelector('span:last-child > span:last-child')!
      const style = getComputedStyle(title)
      return {
        header: head.getBoundingClientRect().height,
        wordmark: mark.getBoundingClientRect().height,
        lines: Math.round(
          title.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
        ),
      }
    })

    expect(box.lines, `the title broke onto ${box.lines} lines at ${width}px`)
      .toBeLessThanOrEqual(2)
    // Strictly inside, not merely equal: a wordmark exactly as tall as the
    // header is one that has already run out of room.
    expect(box.wordmark, `the wordmark is ${box.wordmark}px in a ${box.header}px header`)
      .toBeLessThan(box.header)
  })
}

test('About keeps its label at the narrowest supported width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/the-breast/anatomy')

  const about = page.locator('[data-header-actions] a[href="/about"]')
  await expect(about.locator('[data-about-label]')).toHaveText('About')
  // And it stays a real tap target while shedding its glyph.
  const box = await about.boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)
})
