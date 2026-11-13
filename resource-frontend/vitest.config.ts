import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  define: {
    // The standalone build's values: the suite exercises the app, and the
    // plugin build differs only in routing (memory vs history) and CSS.
    __IS_PLUGIN__: 'false',
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    // The suites for the functions this app contributed back to copper3d
    // moved out with them: they live in that repo now and run against
    // copper3d's own harness. What is left here is this app's own code.
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Imaging URLs as a root-relative deploy resolves them, so assertions
    // read `/modelView/...` rather than the dev backend's absolute origin.
    // It also marks a build without a backend (`hasBackend()`), so a test
    // that needs My MRI's route or sidebar entry stubs it empty.
    env: { VITE_ASSET_BASE: '/modelView/' },
  },
})
