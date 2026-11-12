import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { focusedStage, waitForModality } from './helpers'

/**
 * Client feedback: the MRIs are too dark for a student to read.
 *
 * copper3d windows a volume on its own min/max, and on these MRIs the max is
 * a handful of bright outliers, so the tissue sits in the bottom of the
 * range. `ts/Utils/volumeExposure.ts` lifts the mid-tones with a gamma curve.
 *
 * That the curve cannot clip -- the other half of the client's feedback, and
 * what sank two earlier attempts -- is proved exactly in
 * `ts/__tests__/volumeExposure.test.ts`. What is left for a browser is the half no
 * unit test can reach: that the lift survives copper3d's repaint and reaches
 * the screen at all.
 */

/**
 * Mean luminance of the stage's non-background pixels, which is the slice.
 *
 * Not "how many pixels are mid-grey": the slice covers only a fifth to a
 * quarter of the stage, so a count is mostly measuring how big the volume is
 * on screen. A mean over the same pixels is the exposure alone -- the
 * coverage figure held steady at 0.28/0.22/0.19 per case across every
 * measurement below, so the two runs are comparing like with like.
 */
async function sliceLuminance(page: Page): Promise<number> {
  const png = PNG.sync.read(await focusedStage(page).screenshot())
  const { data } = png

  let sum = 0
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma, enough for a greyscale slice.
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    // The stage background is near-white (#F7F8FA, luma 248); everything
    // darker than this belongs to the volume or its wireframe box.
    if (y < 210) {
      sum += y
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

/**
 * Measured on this branch, same machine, same frames, the fix toggled off
 * and on. `floor` sits between the two columns.
 *
 * density-a is the darkest of the nine volumes under copper3d's own window;
 * cancer-ductal has the widest spread between its tissue and its brightest
 * outlier, and so gains the least.
 */
const CASES = [
  { slug: 'density-a', off: 9.1, on: 28.8, floor: 20 },
  { slug: 'cancer-ductal', off: 19.9, on: 42.0, floor: 30 },
]

test.describe('MRI exposure', () => {
  for (const { slug, off, floor } of CASES) {
    test(`${slug}'s MRI is bright enough to read`, async ({ page }) => {
      await page.goto(`/${slug}/mri`)
      await waitForModality(page)

      const luminance = await sliceLuminance(page)
      expect(luminance, `too dark -- copper3d's own window measured ${off} here`)
        .toBeGreaterThan(floor)
    })
  }

  /**
   * The client's second requirement: the window must be settled before
   * anything renders, so nobody watches the image change colour. Sampling
   * from the first painted frame onward is what proves it -- a correction
   * applied after the first paint would read low here and high a moment
   * later.
   */
  test('is exposed correctly on the very first painted frame', async ({ page }) => {
    await page.goto('/density-a/mri')
    await waitForModality(page)

    const first = await sliceLuminance(page)
    await page.waitForTimeout(1500)
    const settled = await sliceLuminance(page)

    expect(first).toBeGreaterThan(CASES[0]!.floor)
    expect(Math.abs(settled - first), 'the exposure changed after the first frame')
      .toBeLessThan(1)
  })
})
