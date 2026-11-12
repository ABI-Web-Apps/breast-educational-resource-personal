import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { useViewerStore } from '../src/stores/viewer'
import AppHeader from '../src/components/nav/AppHeader.vue'
import CaseSidebar from '../src/components/nav/CaseSidebar.vue'
import DefaultLayout from '../src/layouts/DefaultLayout.vue'

const AppLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

function mountHeader() {
  return mount(AppHeader, {
    global: { stubs: { AppLink: AppLinkStub } },
  })
}

describe('AppHeader', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // Both the mobile drawer toggle and the desktop panel-collapse toggle
  // carry aria-controls="case-sidebar" (they control the same element, just
  // at different tiers), so `button[aria-controls="case-sidebar"]` alone is
  // ambiguous now -- every selector below disambiguates by aria-label.

  it('reflects the store\'s sidebarOpen state on the mobile/tablet drawer toggle', () => {
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountHeader()
    const toggle = wrapper.get('button[aria-label="Toggle case navigation"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
  })

  it('toggles store.sidebarOpen when the hamburger is clicked', async () => {
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountHeader()
    const hamburger = wrapper.get('button[aria-label="Toggle case navigation"]')
    await hamburger.trigger('click')
    expect(store.sidebarOpen).toBe(true)
    await hamburger.trigger('click')
    expect(store.sidebarOpen).toBe(false)
  })

  it('the hamburger is mobile/tablet only: xl+ has its own dedicated collapse button instead', () => {
    // Round 3 made this button visible at every width so one field/control
    // could serve both the drawer and the desktop collapse -- which is
    // exactly what let sidebarOpen's single default be wrong for one tier
    // or the other. Reverted: the hamburger only ever drives the drawer.
    const wrapper = mountHeader()
    const hamburger = wrapper.get('button[aria-label="Toggle case navigation"]')
    expect(hamburger.classes()).toContain('xl:hidden')
  })

  it('the mobile drawer toggle\'s aria-controls matches the id CaseSidebar actually renders', () => {
    // Previously compared aria-controls to the literal 'case-sidebar' without
    // ever mounting CaseSidebar, so renaming CaseSidebar's id would still
    // pass. Mounting both and comparing the live values means either side
    // drifting from the other actually fails this.
    const header = mountHeader()
    const sidebar = mount(CaseSidebar, { global: { stubs: { AppLink: AppLinkStub } } })
    expect(header.get('button[aria-label="Toggle case navigation"]').attributes('aria-controls'))
      .toBe(sidebar.get('nav').attributes('id'))
  })

  it('links to home and about', () => {
    const wrapper = mountHeader()
    const links = wrapper.findAllComponents(AppLinkStub)
    const targets = links.map(l => l.props('to'))
    expect(targets).toContain('/')
    expect(targets).toContain('/about')
  })

  it('the hamburger and the About link both meet the 44px tap-target floor', () => {
    // happy-dom has no real layout engine, so this can't measure actual
    // rendered pixels -- it asserts the Tailwind utilities that are the only
    // thing controlling the size (size-11 = 44px, min-h-11 = 44px min
    // height). Sizing needs a real browser to confirm the rendered box.
    const wrapper = mountHeader()
    const hamburger = wrapper.get('button[aria-label="Toggle case navigation"]')
    expect(hamburger.classes()).toContain('size-11')

    const about = wrapper.findAllComponents(AppLinkStub)
      .find(l => l.props('to') === '/about')!
    expect(about.classes()).toContain('min-h-11')
  })

  describe('sidebar-panel toggle (design doc §10.1, desktop-only)', () => {
    it('reflects and toggles store.sidebarExpanded, independently of sidebarOpen', async () => {
      const store = useViewerStore()
      store.sidebarOpen = false
      store.sidebarExpanded = true
      const wrapper = mountHeader()
      const toggle = wrapper.get('button[aria-label="Toggle case navigation panel"]')
      expect(toggle.attributes('aria-expanded')).toBe('true')

      await toggle.trigger('click')
      expect(store.sidebarExpanded).toBe(false)
      expect(store.sidebarOpen).toBe(false) // untouched by the desktop control
      expect(toggle.attributes('aria-expanded')).toBe('false')
    })

    it('only renders (as a flex box) at xl+, since below xl this is the drawer\'s job instead', () => {
      const wrapper = mountHeader()
      const toggle = wrapper.get('button[aria-label="Toggle case navigation panel"]')
      expect(toggle.classes()).toContain('hidden')
      expect(toggle.classes()).toContain('xl:flex')
    })

    it('aria-controls matches the id CaseSidebar actually renders, same as the drawer toggle', () => {
      const header = mountHeader()
      const sidebar = mount(CaseSidebar, { global: { stubs: { AppLink: AppLinkStub } } })
      expect(header.get('button[aria-label="Toggle case navigation panel"]').attributes('aria-controls'))
        .toBe(sidebar.get('nav').attributes('id'))
    })
  })

  describe('content-panel toggle (design doc §10.1, desktop-only)', () => {
    it('reflects and toggles store.contentOpen', async () => {
      const store = useViewerStore()
      store.contentOpen = true
      const wrapper = mountHeader()
      const toggle = wrapper.get('button[aria-label="Toggle content panel"]')
      expect(toggle.attributes('aria-expanded')).toBe('true')

      await toggle.trigger('click')
      expect(store.contentOpen).toBe(false)
      expect(toggle.attributes('aria-expanded')).toBe('false')
    })

    it('only renders (as a flex box) at xl+, since below xl the content pane has no collapse concept', () => {
      const wrapper = mountHeader()
      const toggle = wrapper.get('button[aria-label="Toggle content panel"]')
      expect(toggle.classes()).toContain('hidden')
      expect(toggle.classes()).toContain('xl:flex')
    })

    it('aria-controls matches the id the content panel actually renders, so the a11y contract holds', () => {
      const header = mountHeader()
      const layout = mount(DefaultLayout, {
        global: {
          stubs: {
            AppHeader: { template: '<header />' },
            CaseSidebar: { template: '<nav id="case-sidebar" />' },
          },
        },
        slots: { stage: '<div />', content: '<div />' },
      })
      expect(header.get('button[aria-label="Toggle content panel"]').attributes('aria-controls'))
        .toBe(layout.get('#case-content-panel').attributes('id'))
    })
  })

  describe('right-hand controls stay right-aligned at every width (client feedback item 10)', () => {
    // The auto margin used to live on the content-panel toggle, which is
    // `hidden ... xl:flex`. Below xl that button is display:none and takes
    // its margin with it, so About collapsed back against the wordmark --
    // visible on an iPad Air (1180px) and invisible on desktop. The margin
    // has to live on something that is present at every width.
    it('the auto margin is not on the xl-only content-panel toggle', () => {
      const wrapper = mountHeader()
      const toggle = wrapper.get('button[aria-label="Toggle content panel"]')
      expect(toggle.classes()).not.toContain('ml-auto')
    })

    it('the auto margin is on a wrapper that renders at every width', () => {
      const wrapper = mountHeader()
      const group = wrapper.get('[data-header-actions]')
      expect(group.classes()).toContain('ml-auto')
      // Nothing may hide the wrapper itself at any tier -- that would
      // reintroduce exactly the bug this block exists for.
      expect(group.classes()).not.toContain('hidden')
      expect(group.classes().some(c => c.endsWith(':hidden'))).toBe(false)
    })

    it('the About link is inside that wrapper', () => {
      const wrapper = mountHeader()
      const about = wrapper.get('[data-header-actions] a[href="/about"]')
      expect(about.text()).toBe('About')
    })

    /**
     * The wrapper reparents two controls that used to be direct children of
     * the header, so it has to reproduce the spacing they were getting from
     * the header's own gap. Read both back rather than hardcoding the value
     * twice: if the header's spacing is retuned later, this test should
     * follow it, not fight it.
     */
    it('spaces its children the way the header spaced them before', () => {
      const wrapper = mountHeader()
      const headerGap = wrapper.get('header').classes().find(c => /^gap-\d/.test(c))
      const groupGap = wrapper.get('[data-header-actions]').classes().find(c => /^gap-\d/.test(c))
      expect(headerGap).toBeDefined()
      expect(groupGap).toBe(headerGap)
    })

    it('About is a filled control, not bare text: it reads as a button without hover', () => {
      // The bug this fixes: About had only `hover:bg-surface-sunken`, and a
      // touch device never hovers, so on iPad and phone it was a grey word.
      // HUD redesign (T3) swapped the heavy black fill for a soft neutral
      // one; it must still be filled at rest, not reliant on :hover.
      const wrapper = mountHeader()
      const about = wrapper.get('[data-header-actions] a[href="/about"]')
      expect(about.classes()).toContain('bg-surface-sunken')
      expect(about.classes()).toContain('text-text')
    })

    it('About keeps its visible label at every width', () => {
      // It outranks the tour button (Task 8), so it must never collapse to
      // an icon the way that one does below md.
      const wrapper = mountHeader()
      const about = wrapper.get('[data-header-actions] a[href="/about"]')
      const label = about.get('[data-about-label]')
      expect(label.text()).toBe('About')
      expect(label.classes().some(c => c.endsWith(':hidden') || c === 'hidden')).toBe(false)
    })

    it('About is the last control in the cluster (the end position)', () => {
      const wrapper = mountHeader()
      const group = wrapper.get('[data-header-actions]')
      const last = group.element.lastElementChild as HTMLElement
      expect(last.getAttribute('href')).toBe('/about')
    })

    it('About still meets the 44px tap-target floor', () => {
      const wrapper = mountHeader()
      const about = wrapper.get('[data-header-actions] a[href="/about"]')
      expect(about.classes()).toContain('min-h-11')
    })

    it('the Guided tour button sits before About, so About keeps the end position', () => {
      const wrapper = mountHeader()
      const group = wrapper.get('[data-header-actions]')
      const children = Array.from(group.element.children) as HTMLElement[]
      const tourIndex = children.findIndex(c => c.hasAttribute('data-tour-open'))
      const aboutIndex = children.findIndex(c => c.getAttribute('href') === '/about')
      expect(tourIndex).toBeGreaterThanOrEqual(0)
      expect(tourIndex).toBeLessThan(aboutIndex)
    })

    it('the Guided tour button is an outline, never a rose fill', () => {
      // Rose is the focus semantic; spending it on a permanent button blurs
      // what "current" means in the sidebar and on the focused panel.
      const wrapper = mountHeader()
      const btn = wrapper.get('[data-tour-open]')
      expect(btn.classes()).toContain('border')
      expect(btn.classes().some(c => c.startsWith('bg-brand'))).toBe(false)
    })

    it('the Guided tour label collapses to screen-reader-only below md', () => {
      const wrapper = mountHeader()
      expect(wrapper.get('[data-tour-label]').classes()).toContain('max-md:sr-only')
    })

    it('emits startTour when pressed', async () => {
      const wrapper = mountHeader()
      await wrapper.get('[data-tour-open]').trigger('click')
      expect(wrapper.emitted('startTour')).toHaveLength(1)
    })
  })
})
