import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/postcss'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import cssInjectedByJs from 'vite-plugin-css-injected-by-js'
import { VitePWA } from 'vite-plugin-pwa'
import type { VitePWAOptions } from 'vite-plugin-pwa'
import { scopeToRoot } from './tooling/postcss-scope'
import { readAppVersion } from './version'

/**
 * Installable app shell (client feedback item 1), standalone build only, as
 * the Nuxt app had it via @vite-pwa/nuxt -- manifest fields verbatim.
 *
 * APP SHELL ONLY. The imaging catalogue (~350MB) is served by the backend and
 * never precached: Chromium will not store responses that size, and listing
 * them would bloat sw.js for nothing.
 *
 * `navigateFallback` is index.html: this is a single-page app now, so every
 * route -- including a bad slug, which the app itself turns into the 404
 * page -- is the same document.
 *
 * Exported so test/pwa.test.ts can assert on it without running a build.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'autoUpdate',
  manifest: {
    name: 'Breast Educational Resource',
    short_name: 'Breast Education App',
    description: 'An ABI Education App for Breast Cancer.',
    theme_color: '#ffffff',
    background_color: '#FBF7F8',
    display: 'standalone',
    icons: [
      { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
    globIgnores: ['**/modelView/**', '**/draco/**'],
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/\/api\//, /\/modelView\//],
  },
}

/**
 * Two builds from one source tree:
 *
 *   yarn build          the standalone site (index.html, PWA) -> build/
 *   yarn build:plugin   the UMD bundle the portal mounts      -> dist/
 *
 * The plugin build follows the portal's contract (see the workspace
 * CLAUDE.md): Vue, Pinia, Vuetify and vue-toastification are externals
 * supplied by the portal as globals, the CSS is injected by the bundle
 * itself, and the portal's builder rewrites `lib.name`, `formats` and
 * `fileName` below with regexes -- keep their shapes.
 */
export default defineConfig(({ command }) => {
  const isBuild = command === 'build'
  const isPluginBuild = process.env.BUILD_AS_PLUGIN === 'true'

  return {
    // A subpath deploy (GitHub Pages serves a project site under
    // /<repo>/) sets APP_BASE_URL. The plugin resolves its own files at
    // runtime from the bundle's URL, so it needs no base at all.
    base: isPluginBuild ? '' : (process.env.APP_BASE_URL ?? '/'),

    plugins: [
      vue(),
      ...(isPluginBuild ? [cssInjectedByJs()] : [VitePWA(pwaOptions)]),
    ],

    css: {
      postcss: {
        plugins: [
          tailwindcss(),
          ...(isPluginBuild
            ? [scopeToRoot({
                rootClass: 'ber-root',
                isMainStylesheet: file => Boolean(file && /tokens\.css$/.test(file)),
              })]
            : []),
        ],
      },
    },

    define: {
      __IS_PLUGIN__: JSON.stringify(isPluginBuild),
      __APP_VERSION__: JSON.stringify(readAppVersion(fileURLToPath(new URL('./package.json', import.meta.url)))),
      // A UMD bundle runs straight in the browser, where `process` does not
      // exist; library mode leaves `process.env.NODE_ENV` in place for a
      // consumer's bundler that will never come.
      ...(isPluginBuild ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {}),
    },

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      host: '0.0.0.0',
      port: 3158,
    },

    // `vite preview` serves the production build, which asks for `/api` on
    // its own origin -- the same contract nginx fulfils in Docker.
    preview: {
      port: 4173,
      proxy: { '/api': 'http://localhost:8082' },
    },

    build: isPluginBuild
      ? {
          lib: {
            entry: './src/index.ts',
            name: 'BreastEducationalResource',
            formats: ['umd'],
            fileName: (format) => `my-app.${format}.js`,
          },
          rollupOptions: {
            external: ['vue', 'vuetify', 'pinia', 'vue-toastification'],
            output: {
              globals: {
                'vue': 'Vue',
                'vuetify': 'Vuetify',
                'pinia': 'Pinia',
                'vue-toastification': 'VueToastification',
              },
            },
          },
        }
      : {
          outDir: 'build',
          emptyOutDir: isBuild,
        },
  }
})
