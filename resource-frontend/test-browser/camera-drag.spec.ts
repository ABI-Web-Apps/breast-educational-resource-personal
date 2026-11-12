import type { Locator } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'
import { focusedStage, waitForModality } from './helpers'

/**
 * That dragging the model actually turns it.
 *
 * Trivial-sounding, and the one thing nothing else here covered. The stage
 * renders on demand, and `Copper3dTrackballControls` dispatches `change` only
 * from inside its `update()`, which only runs inside `render()`. Those two
 * facts close a deadlock -- no frame, so no update, so the camera never
 * moves, so no `change`, so nothing ever asks for a frame -- and the symptom
 * is a viewer that ignores the mouse completely while every unit test stays
 * green. copper3d 3.9.0's `updateOnInput` is what breaks it;
 * `installTrackballControls` turns it on.
 *
 * Measured as a pixel difference rather than by reading the camera, so the
 * test asserts what the reader sees and stays out of the library's internals.
 */

/** Fraction of pixels that differ between two screenshots of the same box. */
async function pixelChange(stage: Locator, act: () => Promise<void>): Promise<number> {
  const before = PNG.sync.read(await stage.screenshot())
  await act()
  // On-demand rendering: the frame the drag requested is one rAF away.
  await stage.page().waitForTimeout(300)
  const after = PNG.sync.read(await stage.screenshot())

  expect(after.data.length).toBe(before.data.length)

  let differing = 0
  for (let i = 0; i < before.data.length; i += 4) {
    // 8 per channel absorbs anti-aliasing jitter without hiding a rotation.
    if (Math.abs(before.data[i]! - after.data[i]!) > 8
      || Math.abs(before.data[i + 1]! - after.data[i + 1]!) > 8
      || Math.abs(before.data[i + 2]! - after.data[i + 2]!) > 8) {
      differing++
    }
  }
  return differing / (before.data.length / 4)
}

test.describe('camera drag', () => {
  test('dragging the anatomy model rotates it', async ({ page }) => {
    // Anatomy: a GLB with no slice plane, so a drag is unambiguously the
    // camera and never the slice scrubber.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/the-breast')
    await waitForModality(page)

    const stage = focusedStage(page)
    const box = (await stage.boundingBox())!
    const midY = box.y + box.height / 2

    const changed = await pixelChange(stage, async () => {
      await page.mouse.move(box.x + box.width * 0.35, midY)
      await page.mouse.down()
      // Several steps, not one jump: the trackball integrates per move, and
      // a single large delta is not what a hand produces.
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(box.x + box.width * (0.35 + 0.04 * i), midY)
      }
      await page.mouse.up()
    })

    expect(changed, 'the drag did not move the camera -- the viewer is dead to the mouse')
      .toBeGreaterThan(0.02)
  })

  /**
   * The other half, and the one that broke when the camera pump was removed:
   * a drag that lands ON the slice plane scrubs instead of orbiting, and the
   * scrub has to get itself on screen.
   *
   * `applyIndex` redraws the slice's backing canvas, which is not a frame.
   * The scrub also suppresses rotation for its whole gesture, so the controls
   * dispatch no `change` -- there is nothing else to schedule the draw, and
   * the image silently stops updating mid-drag while every unit test that
   * only checks the slice NUMBER stays green.
   */
  test('dragging the slice plane scrubs through the volume', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/density-d/mammogram')
    await waitForModality(page)

    const stage = focusedStage(page)
    const box = (await stage.boundingBox())!
    const midX = box.x + box.width / 2
    const midY = box.y + box.height / 2

    const changed = await pixelChange(stage, async () => {
      await page.mouse.move(midX, midY)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) await page.mouse.move(midX, midY + i * 8)
      await page.mouse.up()
    })

    expect(changed, 'the slice did not change -- scrub repainted but never drew')
      .toBeGreaterThan(0.01)
  })

  test('a wheel notch zooms', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/the-breast')
    await waitForModality(page)

    const stage = focusedStage(page)
    const box = (await stage.boundingBox())!

    const changed = await pixelChange(stage, async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      // The trackball's wheel handler dispatches start and end back to back
      // and leaves the zoom itself for the next update -- the same deadlock
      // as the drag, by a different route.
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120)
    })

    expect(changed, 'the wheel did not zoom')
      .toBeGreaterThan(0.02)
  })
})
