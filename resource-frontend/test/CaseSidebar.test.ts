import { computed, defineComponent } from 'vue'
import { providePageRoute } from '../src/navigation/router'
import type { PageRoute } from '../src/navigation/routes'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewerStore } from '../src/stores/viewer'
import { enabledCases } from '../src/content/cases'
import CaseSidebar from '../src/components/nav/CaseSidebar.vue'

const AppLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

function mountSidebar() {
  return mount(CaseSidebar, {
    global: { stubs: { AppLink: AppLinkStub } },
  })
}

/** Focus assertions need real DOM attachment (`document.activeElement`
 *  otherwise never updates) and a way to simulate "below xl" without a
 *  real browser evaluating the `max-xl:fixed` rule, since Tailwind's
 *  compiled CSS isn't loaded in these component tests. CaseSidebar reads
 *  drawer-vs-resident mode via `getComputedStyle(nav).position`, so
 *  stubbing that single browser API is enough to exercise the real
 *  trap/Escape/focus-move logic exactly as it runs in a browser below xl. */
function mountSidebarAsDrawer(open: boolean) {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue(
    { position: 'fixed' } as CSSStyleDeclaration,
  )
  const store = useViewerStore()
  store.sidebarOpen = open
  return mount(CaseSidebar, {
    attachTo: document.body,
    global: { stubs: { AppLink: AppLinkStub } },
  })
}

describe('CaseSidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders the nav landmark AppHeader\'s hamburger points at', () => {
    const wrapper = mountSidebar()
    expect(wrapper.get('nav').attributes('id')).toBe('case-sidebar')
    expect(wrapper.get('nav').attributes('aria-label')).toBe('Cases')
  })

  it('lists exactly the enabled cases, never the disabled one', () => {
    const wrapper = mountSidebar()
    // Scoped to the case list. The sidebar also carries a partner-logo link
    // to /about at its foot and (since client feedback item 8) a dedicated
    // home row above the groups -- neither is a case bullet and neither may
    // be counted here.
    const links = wrapper.findAll('li a').filter(a => a.attributes('href') !== '/my-mri')
      .map(el => wrapper.findAllComponents(AppLinkStub).find(c => c.element === el.element)!)
    const grouped = enabledCases().filter(c => c.slug !== 'the-breast')
    expect(links).toHaveLength(grouped.length)
    const hrefs = links.map(l => l.props('to'))
    expect(hrefs).not.toContain('/benign-calcifications')
    expect(hrefs).not.toContain('/the-breast')
    for (const c of grouped) {
      expect(hrefs).toContain(`/${c.slug}`)
    }
  })

  /**
   * Client feedback item 8: "starts with The breast heading under a bullet
   * point when seems it should be a section on it's own". It is already the
   * target of `/`'s redirect, so it is the home page; it just did not look
   * like one.
   */
  describe('the-breast is the home row, not a case bullet', () => {
    it('renders outside the group lists', () => {
      const wrapper = mountSidebar()
      const groupHrefs = wrapper.findAll('li a').map(a => a.attributes('href'))
      expect(groupHrefs).not.toContain('/the-breast')
    })

    it('still links to /the-breast, from a dedicated home row', () => {
      const wrapper = mountSidebar()
      const home = wrapper.get('[data-home-row]')
      expect(home.attributes('href')).toBe('/the-breast')
      expect(home.text()).toContain('The Breast')
    })

    it('marks the home row as current when it is the active case', () => {
      const store = useViewerStore()
      store.caseSlug = 'the-breast'
      const wrapper = mountSidebar()
      expect(wrapper.get('[data-home-row]').attributes('aria-current')).toBe('page')
      expect(wrapper.findAll('a[aria-current="page"]')).toHaveLength(1)
    })

    it('does not mark the home row as current on another case', () => {
      const store = useViewerStore()
      store.caseSlug = 'density-c'
      const wrapper = mountSidebar()
      expect(wrapper.get('[data-home-row]').attributes('aria-current')).toBeUndefined()
    })

    it('renders exactly the three real case group headings, then Your results', () => {
      const wrapper = mountSidebar()
      expect(wrapper.findAll('h2').map(h => h.text()))
        .toEqual(['Breast Density', 'Benign Conditions', 'Breast Cancer', 'Your results'])
    })
  })

  /** Client feedback item 9. Icons on the home row and the three group
   *  headings only -- deliberately not one per case, see the component. */
  describe('icons', () => {
    it('the home row has one', () => {
      const wrapper = mountSidebar()
      expect(wrapper.get('[data-home-row]').findAll('svg')).toHaveLength(1)
    })

    it('each group heading has one, marked decorative', () => {
      const wrapper = mountSidebar()
      const headings = wrapper.findAll('h2')
      expect(headings).toHaveLength(4)
      for (const h of headings) {
        const icons = h.findAll('svg')
        expect(icons).toHaveLength(1)
        expect(icons[0]!.attributes('aria-hidden')).toBe('true')
      }
    })

    it('case rows keep their dot and gain no icon', () => {
      const wrapper = mountSidebar()
      for (const row of wrapper.findAll('li a').filter(a => a.attributes('href') !== '/my-mri')) {
        expect(row.findAll('svg')).toHaveLength(0)
      }
    })
  })

  it('marks the case matching store.caseSlug as current, and only that one', () => {
    const store = useViewerStore()
    store.caseSlug = 'density-c'
    const wrapper = mountSidebar()
    const current = wrapper.findAll('a[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.attributes('href')).toBe('/density-c')
  })

  it('re-renders the active link when the store slug changes', async () => {
    const store = useViewerStore()
    store.caseSlug = 'the-breast'
    const wrapper = mountSidebar()
    expect(wrapper.get('a[aria-current="page"]').attributes('href')).toBe('/the-breast')

    store.caseSlug = 'cancer-dcis'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('a[aria-current="page"]').attributes('href')).toBe('/cancer-dcis')
  })

  describe('modal behaviour while it is the below-xl drawer', () => {
    it('moves focus to the first case link when the drawer opens', async () => {
      const wrapper = mountSidebarAsDrawer(false)
      const store = useViewerStore()
      store.sidebarOpen = true
      await wrapper.vm.$nextTick() // watcher fires
      await wrapper.vm.$nextTick() // nextTick() inside the watcher resolves
      expect(document.activeElement).toBe(wrapper.get('a').element)
    })

    it('returns focus to whatever triggered the open, once the drawer closes', async () => {
      const trigger = document.createElement('button')
      document.body.appendChild(trigger)
      trigger.focus()
      expect(document.activeElement).toBe(trigger)

      const wrapper = mountSidebarAsDrawer(false)
      const store = useViewerStore()
      store.sidebarOpen = true
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).not.toBe(trigger)

      store.sidebarOpen = false
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(trigger)
      trigger.remove()
    })

    it('Escape closes the drawer', async () => {
      const wrapper = mountSidebarAsDrawer(true)
      const store = useViewerStore()
      await wrapper.get('nav').trigger('keydown', { key: 'Escape' })
      expect(store.sidebarOpen).toBe(false)
    })

    it('Tab on the last link wraps focus back to the first (and Shift+Tab wraps the other way)', async () => {
      const wrapper = mountSidebarAsDrawer(true)
      const links = wrapper.findAll('a')
      const first = links[0]!.element as HTMLElement
      const last = links[links.length - 1]!.element as HTMLElement

      last.focus()
      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      last.dispatchEvent(tabEvent)
      expect(tabEvent.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(first)

      first.focus()
      const shiftTabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      first.dispatchEvent(shiftTabEvent)
      expect(shiftTabEvent.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(last)
    })

    it('does none of this at xl+, where the same <nav> is not a modal', async () => {
      // Same component, same store state, but getComputedStyle reports the
      // resident (non-fixed) position xl+ actually renders it with.
      vi.spyOn(window, 'getComputedStyle').mockReturnValue(
        { position: 'static' } as CSSStyleDeclaration,
      )
      const store = useViewerStore()
      store.sidebarOpen = true
      const wrapper = mount(CaseSidebar, {
        attachTo: document.body,
        global: { stubs: { AppLink: AppLinkStub } },
      })
      await wrapper.get('nav').trigger('keydown', { key: 'Escape' })
      expect(store.sidebarOpen).toBe(true) // unaffected -- desktop nav ignores Escape
    })
  })

  /**
   * The version used to sit under the partner logos here. It is gone at the
   * human's instruction, and nothing is lost by that: the About page has
   * carried "Breast Educational Resource v{version}" the whole time, which
   * is where a reader goes looking for provenance anyway. Pinning the
   * ABSENCE, because a stray reintroduction would otherwise be invisible.
   */
  it('does not put the app version in the persistent chrome', () => {
    expect(mountSidebar().find('[data-app-version]').exists()).toBe(false)
  })
})

describe('CaseSidebar: YOUR RESULTS group', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  afterEach(() => { document.body.innerHTML = '' })

  function mountOn(route: PageRoute) {
    const Host = defineComponent({
      components: { CaseSidebar },
      setup() { providePageRoute(computed(() => route)) },
      template: '<CaseSidebar />',
    })
    return mount(Host, { global: { stubs: { AppLink: AppLinkStub } } })
  }
  const myMri: PageRoute = { path: '/my-mri', name: 'my-mri', params: {} }

  it('lists YOUR RESULTS > My MRI after the cancer group', () => {
    const headings = mountSidebar().findAll('h2').map(h => h.text().toLowerCase())
    expect(headings.slice(-2)).toEqual(['breast cancer', 'your results'])
  })

  it('links My MRI to /my-mri with the subtitle', () => {
    const link = mountSidebar().findAll('a').find(a => a.attributes('href') === '/my-mri')!
    expect(link.text()).toContain('My MRI')
    expect(link.text()).toContain('Scan and report')
  })

  it('marks My MRI active on /my-mri, and no case', () => {
    const wrapper = mountOn(myMri)
    const link = wrapper.findAll('a').find(a => a.attributes('href') === '/my-mri')!
    expect(link.attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('does not mark My MRI active on a case page', () => {
    const wrapper = mountOn({ path: '/the-breast', name: 'case', params: { slug: 'the-breast' } })
    const link = wrapper.findAll('a').find(a => a.attributes('href') === '/my-mri')!
    expect(link.attributes('aria-current')).toBeUndefined()
  })
})
