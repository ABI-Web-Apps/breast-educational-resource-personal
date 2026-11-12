import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StageApi } from '../src/composables/copper-types'
import { useCopperStage } from '../src/composables/useCopperStage'

/**
 * `useCopperStage`'s render loop / cancellation logic is genuinely
 * testable without WebGL: happy-dom can mount a real component (so
 * onMounted/onScopeDispose fire for real), and copper3d itself is mocked
 * out entirely -- only the refcounting and lifecycle bookkeeping around it
 * is under test here, not any actual rendering. What still needs a real
 * browser: whether copper3d's own WebGLRenderer genuinely produces exactly
 * one canvas across case navigation, and the real (not mocked) rAF
 * behaviour of copperSceneOnDemond's own on-demand render-request dance.
 */

const disposeSpy = vi.fn()
const stopSpy = vi.fn()
const getCurrentSceneSpy = vi.fn(() => ({ onWindowResize: vi.fn() }))

function makeFakeRenderer() {
  return {
    getSceneByName: vi.fn(),
    createScene: vi.fn(),
    setCurrentScene: vi.fn(),
    getCurrentScene: getCurrentSceneSpy,
    render: vi.fn(),
    stop: stopSpy,
    dispose: disposeSpy,
  }
}

// A regular function, not an arrow function: this mock is invoked with
// `new` (matching the real `new mod.copperRendererOnDemond(...)` call
// site), and arrow functions cannot be used as constructors.
const copperRendererOnDemond = vi.fn().mockImplementation(function () {
  return makeFakeRenderer()
})

/**
 * Mocks the app's OWN seam, not the package. `copper3dModule` is what
 * `useCopperStage` imports from, and it is also what `copperExtras` reads the
 * real library out of -- replacing only `loadCopper3d` swaps the renderer
 * without taking copper3d's actual functions away from everything else.
 */
vi.mock('../src/composables/copper3dModule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/composables/copper3dModule')>()),
  loadCopper3d: vi.fn(async () => ({ copperRendererOnDemond, loading: vi.fn() })),
}))

// ResizeObserver isn't implemented in happy-dom.
class FakeResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

const HostWrapper = defineComponent({
  setup() {
    const host = ref<HTMLDivElement>()
    const stage = useCopperStage(host)
    return { host, stage }
  },
  template: '<div ref="host" />',
})

function getStage(wrapper: ReturnType<typeof mount>): StageApi {
  return (wrapper.vm as unknown as { stage: StageApi }).stage
}

describe('useCopperStage', () => {
  beforeEach(() => {
    copperRendererOnDemond.mockClear()
    disposeSpy.mockClear()
    stopSpy.mockClear()
  })

  // Review fix #1: onMounted's `await import('copper3d')` can still be
  // pending when the component unmounts (e.g. rapid case switching while
  // the chunk downloads). baseRenderer's constructor creates a live
  // THREE.WebGLRenderer before it can fail on a missing container, so
  // constructing after unmount would leak an unowned, never-disposed
  // WebGL context -- this proves that construction is skipped entirely.
  it('does not construct a renderer if the component unmounts before the copper3d import resolves', async () => {
    const wrapper = mount(HostWrapper)
    // Unmount synchronously, in the same tick onMounted started in --
    // before the mocked dynamic import's promise has had a chance to
    // resolve.
    wrapper.unmount()
    await flushPromises()

    expect(copperRendererOnDemond).not.toHaveBeenCalled()
  })

  it('disposes the renderer it actually built on a normal unmount', async () => {
    const wrapper = mount(HostWrapper)
    await flushPromises()
    expect(copperRendererOnDemond).toHaveBeenCalledTimes(1)

    wrapper.unmount()

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  // Review fix #2: onScopeDispose used to clear rafId/continuousHolders
  // but set no "disposed" flag, so a call arriving after unmount (e.g. a
  // Task 9/10 animation timer that fires late) would see rafId === null
  // and start a brand new, permanently unowned rAF loop.
  it('requestContinuous/releaseContinuous are no-ops after the component unmounts', async () => {
    const rafSpy = vi.fn(() => 1)
    const cafSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cafSpy)

    const wrapper = mount(HostWrapper)
    await flushPromises()
    const stage = getStage(wrapper)

    wrapper.unmount()
    rafSpy.mockClear()
    cafSpy.mockClear()

    stage.requestContinuous()
    expect(rafSpy).not.toHaveBeenCalled()

    stage.releaseContinuous()
    expect(cafSpy).not.toHaveBeenCalled()
  })

  it('shares a single rAF loop across concurrent continuous holders, and stops it once all release', async () => {
    const rafSpy = vi.fn(() => 1)
    const cafSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cafSpy)

    const wrapper = mount(HostWrapper)
    await flushPromises()
    const stage = getStage(wrapper)
    rafSpy.mockClear()

    stage.requestContinuous() // holder 1 -> starts the loop
    stage.requestContinuous() // holder 2 -> re-entrant, no second loop
    expect(rafSpy).toHaveBeenCalledTimes(1)

    stage.releaseContinuous() // back to 1 holder -> loop keeps running
    expect(cafSpy).not.toHaveBeenCalled()

    stage.releaseContinuous() // back to 0 -> loop stops
    expect(cafSpy).toHaveBeenCalledTimes(1)
  })

  it('loadError starts undefined on the happy path (does not misfire)', async () => {
    const wrapper = mount(HostWrapper)
    await flushPromises()
    expect(getStage(wrapper).loadError.value).toBeUndefined()
  })

  // Round-2 review fix #1: the renderer constructor is a throw site of its
  // own, separate from the dynamic import. `new THREE.WebGLRenderer` throws
  // whenever WebGL is unavailable -- GPU blocklist, WebGL disabled in the
  // browser, or the context budget already exhausted -- and baseRenderer's
  // constructor also runs PMREMGenerator.compileEquirectangularShader().
  // Before the fix the try/catch covered only `await import(...)`, so this
  // path left `ready` false AND `loadError` undefined: a permanently blank
  // stage with nothing rendering the error message, which is exactly the
  // state the loadError channel exists to prevent.
  it('surfaces a constructor failure through loadError instead of a silent blank stage', async () => {
    const boom = new Error('WebGL unavailable')
    // Regular function, not an arrow: this is invoked with `new`, and an
    // arrow would fail as "not a constructor" -- a different error than the
    // one under test.
    copperRendererOnDemond.mockImplementationOnce(function () {
      throw boom
    })

    const wrapper = mount(HostWrapper)
    await flushPromises()

    const stage = getStage(wrapper)
    expect(stage.loadError.value).toBe(boom)
    expect(stage.ready.value).toBe(false)
  })

  // NOT tested, and deliberately so: "the constructor throws after the
  // component unmounted" is structurally unreachable. useCopperStage checks
  // `cancelled` immediately before `new`, with no `await` between the two,
  // so once unmounted the function returns before the constructor is ever
  // called. A test for it would queue a throwing mock that never runs and
  // pass for the same reason the cancellation test above already does --
  // green, but proving nothing. The `if (!cancelled)` guard in the catch
  // block is therefore belt-and-braces against a future edit introducing an
  // await in that window, not a live code path.

  // NOT tested here, deliberately: making the dynamic `import('copper3d')`
  // itself reject (not just the constructor throw, which is a different
  // code path) requires overriding the file's static `vi.mock('copper3d')`
  // per-test via `vi.doMock` + `vi.resetModules()` + a fresh import of the
  // module under test. That's real coverage, but it also mutates global
  // module-registry state this file's other tests share, and cleaning it
  // back up correctly is itself a source of order-dependent flakiness that
  // outweighs the payoff versus just reading useCopperStage.ts's try/catch
  // around the `await import(...)`. This is a genuine gap, not a "trust
  // me": the try/catch's existence is verified by code inspection, but a
  // real chunk-load failure (e.g. throttled/offline network) is left to a
  // browser check.
})
