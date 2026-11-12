import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppLink from '../src/navigation/AppLink.vue'
import { appRouterPlugin, createAppRouter, providePageRoute, usePageRoute } from '../src/navigation/router'
import type { AppRouter } from '../src/navigation/router'
import type { PageRoute } from '../src/navigation/routes'

describe('memory router (plugin mode)', () => {
  it('starts at the home case', () => {
    const router = createAppRouter({ history: false, base: '/' })
    expect(router.route.value).toMatchObject({ path: '/the-breast', name: 'case' })
  })

  it('navigates, following redirects', async () => {
    const router = createAppRouter({ history: false, base: '/', initialPath: '/about' })
    await router.navigateTo('/density-1')
    expect(router.route.value).toMatchObject({ path: '/density-a', name: 'case' })
  })

  it('treats a navigation to the current path as a no-op, as vue-router does', async () => {
    const router = createAppRouter({ history: false, base: '/' })
    const before = router.route.value
    await router.navigateTo('/the-breast/')
    expect(router.route.value).toBe(before)
  })

  it('never touches the browser history', async () => {
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const router = createAppRouter({ history: false, base: '/', initialPath: '/' })
    router.start()
    await router.navigateTo('/about')
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('hands out plain paths for hrefs', () => {
    const router = createAppRouter({ history: false, base: '/ignored/' })
    expect(router.href('/density-c/mri/')).toBe('/density-c/mri')
  })
})

describe('history router (standalone)', () => {
  let router: AppRouter | undefined

  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => {
    router?.stop()
    router = undefined
  })

  it('reads the page from the address bar, and replaces a redirecting URL', () => {
    window.history.replaceState(null, '', '/density-1')
    router = createAppRouter({ history: true, base: '/' })
    expect(router.route.value.path).toBe('/density-a')
    expect(window.location.pathname).toBe('/density-a')
  })

  it('pushes a new entry per navigation, under the deployment base', async () => {
    window.history.replaceState(null, '', '/te-uma/the-breast')
    router = createAppRouter({ history: true, base: '/te-uma/' })
    router.start()
    expect(router.route.value.path).toBe('/the-breast')
    await router.navigateTo('/about')
    expect(window.location.pathname).toBe('/te-uma/about')
    expect(router.href('/density-c')).toBe('/te-uma/density-c')
  })

  it('follows Back/Forward', async () => {
    window.history.replaceState(null, '', '/the-breast')
    router = createAppRouter({ history: true, base: '/' })
    router.start()
    await router.navigateTo('/about')
    window.history.replaceState(window.history.state, '', '/density-c/mri')
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
    expect(router.route.value).toMatchObject({ path: '/density-c/mri', name: 'case' })
  })

  it('stops listening once stopped', () => {
    window.history.replaceState(null, '', '/the-breast')
    router = createAppRouter({ history: true, base: '/' })
    router.start()
    router.stop()
    window.history.replaceState(null, '', '/about')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(router.route.value.path).toBe('/the-breast')
  })
})

describe('AppLink', () => {
  function mountLink(router: AppRouter) {
    return mount(AppLink, {
      props: { to: '/about' },
      slots: { default: 'About' },
      global: { plugins: [appRouterPlugin(router)] },
    })
  }

  it('renders a real link and navigates in place on a primary click', async () => {
    const router = createAppRouter({ history: false, base: '/' })
    const link = mountLink(router)
    expect(link.attributes('href')).toBe('/about')
    await link.trigger('click', { button: 0 })
    expect(router.route.value.name).toBe('about')
  })

  it('leaves a modified click (new tab, new window) to the browser', async () => {
    const router = createAppRouter({ history: false, base: '/' })
    const link = mountLink(router)
    await link.trigger('click', { button: 0, ctrlKey: true })
    await link.trigger('click', { button: 1 })
    expect(router.route.value.name).toBe('case')
  })
})

describe('page route', () => {
  it('is the route its page published, not the live one', async () => {
    const router = createAppRouter({ history: false, base: '/' })
    const frozen: PageRoute = { path: '/density-c/mri', name: 'case', params: { slug: 'density-c', modality: 'mri' } }
    let seen: PageRoute | undefined
    const Child = defineComponent({ setup() { const r = usePageRoute(); return () => { seen = r.value; return h('i') } } })
    const Page = defineComponent({ setup() { providePageRoute({ value: frozen } as never); return () => h(Child) } })
    mount(Page, { global: { plugins: [appRouterPlugin(router)] } })
    await router.navigateTo('/about')
    expect(seen).toBe(frozen)
  })

  it('falls back to the live route outside a page', async () => {
    const router = createAppRouter({ history: false, base: '/' })
    let path = ''
    const Probe = defineComponent({ setup() { const r = usePageRoute(); return () => { path = r.value.path; return h('i') } } })
    const wrapper = mount(Probe, { global: { plugins: [appRouterPlugin(router)] } })
    await router.navigateTo('/about')
    await wrapper.vm.$nextTick()
    expect(path).toBe('/about')
  })
})
