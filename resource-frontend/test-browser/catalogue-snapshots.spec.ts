import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { enabledCases } from '../src/content/cases'
import { focusedStage, waitForModality } from './helpers'

/**
 * Screenshots the stage of every enabled case x modality into
 * `test-results-screens/<SNAPSHOT_LABEL>/<slug>__<modality>.png`, so two runs
 * (e.g. before and after a dependency upgrade) can be compared with
 * `scripts/compare-snapshots.mjs`.
 *
 * It writes files and takes minutes, so it skips itself unless
 * SNAPSHOT_LABEL is set and never runs inside the normal browser suite.
 */
/**
 * Fraction of pixels that differ from the stage background. The reference is
 * sampled just inside the rounded corner (the very corner pixel is outside the
 * radius), where every modality shows plain backdrop.
 */
function drawnFraction(png: PNG): number {
  const { data, width, height } = png
  const o = (24 * width + 24) * 4
  const [br, bg, bb] = [data[o], data[o + 1], data[o + 2]]
  let drawn = 0
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 30) drawn++
  }
  return drawn / (width * height)
}

const MIN_DRAWN = 0.02
const label = process.env.SNAPSHOT_LABEL
const outDir = join(process.cwd(), 'test-results-screens', label ?? '')

test.describe('catalogue snapshots', () => {
  test.skip(!label, 'set SNAPSHOT_LABEL to shoot the catalogue')
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const c of enabledCases()) {
    for (const m of c.modalities) {
      test(`${c.slug} ${m.id}`, async ({ page }) => {
        await page.goto(`/${c.slug}/${m.id}`)
        await waitForModality(page)
        const stage = focusedStage(page)
        // Poll until the stage shows real content and two consecutive frames
        // are identical; fail rather than save a blank or half-loaded capture.
        let previous: Buffer | null = null
        let settled: Buffer | null = null
        let attempts = 0
        await expect.poll(async () => {
          attempts++
          const shot = await stage.screenshot()
          const ok = drawnFraction(PNG.sync.read(shot)) > MIN_DRAWN
            && previous !== null && previous.equals(shot)
          previous = shot
          if (ok) settled = shot
          return ok
        }, { timeout: 60_000, intervals: [500] }).toBe(true)
        console.log(`SNAPSHOT-ATTEMPTS ${c.slug}__${m.id} ${attempts}`)
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, `${c.slug}__${m.id}.png`), settled!)
      })
    }
  }
})
