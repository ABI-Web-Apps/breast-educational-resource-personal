import { describe, expect, it } from 'vitest'
import { pwaOptions } from '../vite.config'

/**
 * Client feedback item 1. Asserts the CONFIGURATION rather than a built
 * service worker: a real build is not a unit test's business. The
 * built-artefact side is covered in test-browser/production.spec.ts.
 */
const pwa = pwaOptions as unknown as {
  registerType: string
  manifest: Record<string, any>
  workbox: Record<string, any>
}

describe('PWA configuration', () => {
  it('updates itself rather than pinning a stale shell behind a prompt', () => {
    expect(pwa.registerType).toBe('autoUpdate')
  })

  it('carries the legacy app\'s manifest fields verbatim', () => {
    expect(pwa.manifest.name).toBe('Breast Educational Resource')
    expect(pwa.manifest.short_name).toBe('Breast Education App')
    expect(pwa.manifest.description).toBe('An ABI Education App for Breast Cancer.')
    expect(pwa.manifest.theme_color).toBe('#ffffff')
  })

  it('declares the icon sizes Task 4 generated, at the paths it wrote them to', () => {
    const bySrc = Object.fromEntries(
      pwa.manifest.icons.map((i: Record<string, string>) => [i.src, i]),
    )
    expect(bySrc['pwa-192x192.png']?.sizes).toBe('192x192')
    expect(bySrc['pwa-512x512.png']?.sizes).toBe('512x512')
    expect(bySrc['maskable-icon-512x512.png']?.purpose).toBe('maskable')
  })

  /**
   * The load-bearing one. The imaging catalogue is ~355MB of NRRD and GLB,
   * and Chromium will not store responses that size anyway. It must never
   * enter the precache manifest.
   */
  it('never precaches the imaging assets', () => {
    const globs: string[] = pwa.workbox.globPatterns
    expect(globs.every(g => !g.includes('nrrd'))).toBe(true)
    expect(globs.every(g => !g.includes('glb'))).toBe(true)
    expect(pwa.workbox.globIgnores).toContain('**/modelView/**')
  })

  it('does not precache the draco decoder wasm either', () => {
    // Only needed when a GLB is actually loaded, which is a network path.
    expect(pwa.workbox.globIgnores).toContain('**/draco/**')
  })

  /**
   * A single-page app: every route is index.html, and the app itself turns
   * an unknown path into its 404 page. The backend's routes are not pages,
   * so a navigation there must reach the network.
   */
  it('falls back to the app shell for navigations, but never for the backend', () => {
    expect(pwa.workbox.navigateFallback).toBe('index.html')
    const denied = (path: string) => (pwa.workbox.navigateFallbackDenylist as RegExp[]).some(re => re.test(path))
    expect(denied('/api/health')).toBe(true)
    expect(denied('/api/modelView/density-1/right/mri.nrrd')).toBe(true)
    expect(denied('/density-c/mri')).toBe(false)
  })
})
