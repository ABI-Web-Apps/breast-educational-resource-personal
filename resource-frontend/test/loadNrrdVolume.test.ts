import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadNrrdVolume } from '../src/composables/loadNrrdVolume'

const SRC = resolve(__dirname, '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|vue)$/.test(name) ? [path] : []
  })
}

describe('loadNrrdVolume', () => {
  it('hands copper3d an absolute URL and every other argument unchanged', () => {
    const scene = { loadNrrd: vi.fn() }
    const bar = {} as never
    const callback = vi.fn()
    const opts = { axes: ['z'] as const }

    loadNrrdVolume(scene, '/api/modelView/a/mri.nrrd', bar, callback, opts)

    expect(scene.loadNrrd).toHaveBeenCalledWith(
      new URL('/api/modelView/a/mri.nrrd', document.baseURI).href, bar, callback, opts)
    expect(scene.loadNrrd.mock.calls[0]![0]).toMatch(/^https?:\/\//)
  })

  /**
   * copper3d fetches volumes inside a `blob:` worker, where a relative URL
   * fails before any request goes out -- and only in the built app, because
   * `yarn dev` happens to use absolute URLs. A call that bypasses the helper
   * would pass every dev-server check, so it is refused here instead.
   */
  it('is the only place in src/ that calls loadNrrd', () => {
    const callers = sourceFiles(SRC)
      .filter(file => /\.loadNrrd\s*\(/.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file).replace(/\\/g, '/'))
    expect(callers).toEqual(['composables/loadNrrdVolume.ts'])
  })
})
