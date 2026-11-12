import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
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
        // Let the first frames land after the loading indicator goes away.
        await page.waitForTimeout(1500)
        mkdirSync(outDir, { recursive: true })
        await stage.screenshot({ path: join(outDir, `${c.slug}__${m.id}.png`) })
      })
    }
  }
})
