import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DECODER_LOADER_RE, threeDecoderDefaults } from '../tooling/three-decoder-defaults'

const LOADERS = resolve(__dirname, '../node_modules/three/examples/jsm/loaders')

/** The shape Vite's asset plugin rewrites -- and then ships the file it names. */
const ASSET_SHAPE = /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/

function transform(code: string, id: string): string | null {
  const plugin = threeDecoderDefaults('__BASE__')
  const hook = plugin.transform as (code: string, id: string) => { code: string } | null
  return hook(code, id)?.code ?? null
}

describe('threeDecoderDefaults', () => {
  it('matches the two loaders, on POSIX and Windows paths, with or without a query', () => {
    for (const id of [
      '/repo/node_modules/three/examples/jsm/loaders/DRACOLoader.js',
      'C:\\repo\\node_modules\\three\\examples\\jsm\\loaders\\KTX2Loader.js',
      '/repo/node_modules/three/examples/jsm/loaders/KTX2Loader.js?v=1',
    ]) expect(DECODER_LOADER_RE.test(id), id).toBe(true)
  })

  it('leaves every other module alone', () => {
    for (const id of [
      '/repo/node_modules/three/examples/jsm/loaders/GLTFLoader.js',
      '/repo/node_modules/copper3d/dist/bundle.esm.mjs',
      '/repo/src/composables/DRACOLoader.js',
    ]) expect(transform('new URL("x", import.meta.url)', id), id).toBeNull()
  })

  // The real files from node_modules, so a three upgrade that changes how
  // they build these URLs fails here rather than shipping the decoders again.
  for (const file of ['DRACOLoader.js', 'KTX2Loader.js']) {
    it(`leaves ${file} nothing for the asset plugin to ship`, () => {
      const source = readFileSync(resolve(LOADERS, file), 'utf8')
      expect(source, 'the premise: three builds its decoder URLs this way').toMatch(ASSET_SHAPE)

      const out = transform(source, resolve(LOADERS, file))!
      expect(out).not.toMatch(ASSET_SHAPE)
      expect(out).not.toContain('import.meta.url')
      expect(out).toContain('__BASE__')
    })
  }
})
