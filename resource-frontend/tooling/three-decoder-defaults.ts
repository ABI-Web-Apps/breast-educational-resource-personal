import type { Plugin } from 'vite'

/** three's two loaders whose default decoder URLs are built at module scope. */
export const DECODER_LOADER_RE = /[\\/]three[\\/]examples[\\/]jsm[\\/]loaders[\\/](?:DRACO|KTX2)Loader\.js(?:\?|$)/

/**
 * Keeps three's default decoder files out of both builds.
 *
 * DRACOLoader and KTX2Loader build their default decoder URLs at module scope
 * (`new URL('../libs/draco/draco_decoder.wasm', import.meta.url)` and four
 * more). Vite's asset plugin recognises that shape and ships every file it
 * names: inlined as base64 in the plugin's UMD bundle (library mode inlines
 * assets), and as hashed files in the standalone build, whose service worker
 * then precaches the decoder JS.
 *
 * None of them is ever fetched. copper3d constructs the only instance of each
 * loader and replaces its path on the very next line, and this app points
 * Draco at its own `public/draco/` (`setDracoDecoderPath`). So this rewrites
 * `import.meta.url` in those two files, before the asset plugin runs, to
 * `base`: an expression the asset plugin does not recognise but that is still
 * a valid absolute URL, so the loaders construct exactly as before and only
 * name files nobody asks for.
 */
export function threeDecoderDefaults(base: string): Plugin {
  return {
    name: 'ber:three-decoder-defaults',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!DECODER_LOADER_RE.test(id)) return null
      return { code: code.replaceAll('import.meta.url', base), map: null }
    },
  }
}
