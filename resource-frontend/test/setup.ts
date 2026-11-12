import { config, DOMWrapper, VueWrapper } from '@vue/test-utils'
import { Storage } from 'happy-dom'
import { vi } from 'vitest'
import { appRouterPlugin, createAppRouter } from '../src/navigation/router'
import type { AppRouter } from '../src/navigation/router'

/**
 * copper3d's real `installFastSliceRepaint` patches a `VolumeSlice` with a
 * canvas-backed repaint, which happy-dom has no business running -- its real
 * behaviour is covered in `test-browser/mri-exposure.spec.ts`. Everything
 * else in the barrel is the genuine library.
 *
 * A test that wants to assert on the patch can override this per file.
 */
vi.mock('../src/composables/copperExtras', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/composables/copperExtras')>()),
  installFastSliceRepaint: vi.fn(async () => {}),
}))

/**
 * Node 25+ ships its own `localStorage` global, which is `undefined` unless
 * Node is started with `--localstorage-file` -- and under Vitest it wins over
 * happy-dom's. Put a real DOM Storage back, which is what the app reads in a
 * browser. (Node 22, which CI and the portal builder use, has no such global,
 * so there this replaces nothing.)
 */
if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true, writable: true })
}

/**
 * Every utility class is written `tw:<utility>` (see tokens.css for why).
 * The assertions in this suite are about WHICH utilities an element has, so
 * `classes()` reports them by their utility name. `classPrefix.test.ts` is
 * what checks the prefix itself is present.
 */
for (const Wrapper of [DOMWrapper, VueWrapper] as const) {
  const original = Wrapper.prototype.classes as (this: unknown, name?: string) => string[] | boolean
  Object.defineProperty(Wrapper.prototype, 'classes', {
    configurable: true,
    value(this: unknown, name?: string) {
      if (name !== undefined) return original.call(this, `tw:${name}`) || original.call(this, name)
      return (original.call(this) as string[]).map(c => c.replace(/^tw:/, ''))
    },
  })
}

/**
 * A router for every mount: a real in-memory one, so links and the
 * components that navigate work unmodified. A test that wants to observe
 * navigation stubs the global `navigateTo` (`vi.stubGlobal`), which the
 * router then defers to -- the seam this suite has always used.
 */
config.global.plugins.push({
  install(app) {
    const router = createAppRouter({ history: false, base: '/' })
    const testRouter: AppRouter = {
      ...router,
      navigateTo: (path, options) => {
        const stub = (globalThis as { navigateTo?: AppRouter['navigateTo'] }).navigateTo
        return typeof stub === 'function' ? Promise.resolve(stub(path, options)) : router.navigateTo(path, options)
      },
    }
    app.use(appRouterPlugin(testRouter))
  },
})
