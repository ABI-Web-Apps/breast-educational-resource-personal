import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { useViewerStore } from '../src/stores/viewer'
import DefaultLayout from '../src/layouts/DefaultLayout.vue'

// AppHeader/CaseSidebar are Task 5's own components but aren't under test
// here -- this file is about the shell's responsive class wiring, which is
// independent of what those two components render.
const AppHeaderStub = { template: '<header />' }
const CaseSidebarStub = { template: '<nav id="case-sidebar" />' }

function mountLayout(slots: Record<string, string> = {}) {
  return mount(DefaultLayout, {
    global: {
      stubs: { AppHeader: AppHeaderStub, CaseSidebar: CaseSidebarStub },
    },
    slots: {
      stage: '<div class="stage-marker">stage content</div>',
      content: '<div class="content-marker">content content</div>',
      ...slots,
    },
  })
}

/** All six design-doc §10.3 regions, each with a distinct marker, so DOM
 *  order can be asserted directly instead of trusting the nesting by eye. */
function mountLayoutWithAllRegions() {
  return mountLayout({
    heading: '<div class="heading-marker">heading</div>',
    stage: '<div class="stage-marker">stage</div>',
    content: '<div class="content-marker">content</div>',
    prevnext: '<div class="prevnext-marker">prevnext</div>',
  })
}

describe('default layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders both slots into the layout', () => {
    const wrapper = mountLayout()
    expect(wrapper.find('.stage-marker').exists()).toBe(true)
    expect(wrapper.find('.content-marker').exists()).toBe(true)
  })

  it('lays out the four regions in the phone order: heading, stage, content, prev/next', () => {
    // This is the order a single (phone-tier) column stacks in DOM order,
    // and also the order xl+'s flex-row split reads within each of its two
    // columns -- one nesting produces the right order at every tier, with
    // no CSS `order` reshuffling to separately verify.
    //
    // Neither `stepper` nor `controls` is a layout region any more. Both
    // now arrive inside `stage`: the slot strip is one-up-only chrome that
    // has to sit next to the layout decision hiding it at three-up, and
    // each panel renders its own control bar. Their position relative to
    // `content` is still fixed by this same nesting.
    const wrapper = mountLayoutWithAllRegions()
    const markers = ['heading-marker', 'stage-marker', 'content-marker', 'prevnext-marker']
    const html = wrapper.html()
    const positions = markers.map(m => html.indexOf(m))
    expect(positions.every(p => p !== -1)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('renders nothing at all for a region the page has not filled', () => {
    // These slots used to carry "Placeholder: case heading (Task 6)" text as
    // their fallback, and that text shipped to production and was the first
    // thing the human asked about. An unfilled slot is now empty; the test
    // that pinned the placeholders is gone with them, replaced by one that
    // pins their absence.
    const wrapper = mountLayout()
    expect(wrapper.text()).not.toMatch(/Placeholder/i)
    expect(wrapper.text()).not.toMatch(/Task \d/)
  })

  it('starts with the drawer closed, so a narrow first load is not covered by it', () => {
    // Regression test for the sidebarOpen default: a phone-width visitor's
    // first paint must be the case they came for, not a drawer + scrim over
    // it. Deliberately does NOT set store.sidebarOpen -- this exercises the
    // store's actual default, not a value forced by the test.
    const wrapper = mountLayout()
    const sidebar = wrapper.getComponent(CaseSidebarStub)
    expect(sidebar.classes()).toContain('max-md:-translate-y-full')
    expect(sidebar.classes()).toContain('md:max-xl:-translate-x-full')
    expect(sidebar.classes()).not.toContain('max-md:translate-y-0')
    expect(sidebar.classes()).not.toContain('md:max-xl:translate-x-0')
    expect(wrapper.find('button[aria-label="Close case navigation"]').exists()).toBe(false)
  })

  it('phone tier (<md): the drawer drops down from the top, not in from the side', async () => {
    // Design doc §10.3: "case navigation moves into a top drawer" -- a
    // different geometry from tablet's left-side drawer, both gated by the
    // same store.sidebarOpen and the same isDrawerMode() in CaseSidebar.
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountLayout()
    const sidebar = wrapper.getComponent(CaseSidebarStub)
    expect(sidebar.classes()).toContain('max-md:top-14')
    expect(sidebar.classes()).toContain('max-md:inset-x-0')
    expect(sidebar.classes()).toContain('max-md:-translate-y-full')
    expect(sidebar.classes()).not.toContain('max-md:left-0')

    store.sidebarOpen = true
    await wrapper.vm.$nextTick()
    expect(sidebar.classes()).toContain('max-md:translate-y-0')
    expect(sidebar.classes()).not.toContain('max-md:-translate-y-full')
  })

  it('tablet tier (md..xl): the drawer slides in from the left, as before', async () => {
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountLayout()
    const sidebar = wrapper.getComponent(CaseSidebarStub)
    expect(sidebar.classes()).toContain('md:max-xl:left-0')
    expect(sidebar.classes()).toContain('md:max-xl:-translate-x-full')

    store.sidebarOpen = true
    await wrapper.vm.$nextTick()
    expect(sidebar.classes()).toContain('md:max-xl:translate-x-0')
    expect(sidebar.classes()).not.toContain('md:max-xl:-translate-x-full')
  })

  it('also toggles visible/invisible at both below-xl tiers (not just the transform), so a closed drawer leaves the tab order', async () => {
    // A translated-off-screen element is still visible and focusable by
    // default; only `visibility: hidden` removes a closed off-canvas drawer
    // from keyboard/screen-reader traversal. Scoped so xl+ (where the
    // sidebar is resident, not a drawer) is never affected.
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountLayout()
    const sidebar = wrapper.getComponent(CaseSidebarStub)
    expect(sidebar.classes()).toContain('max-md:invisible')
    expect(sidebar.classes()).toContain('md:max-xl:invisible')
    expect(sidebar.classes()).not.toContain('max-md:visible')
    expect(sidebar.classes()).not.toContain('md:max-xl:visible')

    store.sidebarOpen = true
    await wrapper.vm.$nextTick()
    expect(sidebar.classes()).toContain('max-md:visible')
    expect(sidebar.classes()).toContain('md:max-xl:visible')
  })

  describe('xl+ desktop collapse (design doc §10.1)', () => {
    it('CRITICAL REGRESSION PIN: sidebarExpanded defaults true, so a desktop visitor has case navigation on first paint', () => {
      // This is the bug: sidebarOpen used to double as xl+'s collapse flag,
      // and defaulted false (correct for the drawer, wrong for a resident
      // panel) -- a desktop visitor landed on xl:w-0. Every test that
      // existed at the time set the flag before mounting, which is exactly
      // why 188 passing tests didn't catch it. This one deliberately sets
      // NEITHER sidebarOpen nor sidebarExpanded, so it exercises the real
      // defaults, not a value the test forced.
      const wrapper = mountLayout()
      const sidebar = wrapper.getComponent(CaseSidebarStub)
      expect(sidebar.classes()).not.toContain('xl:w-0')
      expect(sidebar.classes()).not.toContain('xl:invisible')
      expect(sidebar.classes()).toContain('xl:visible')
    })

    it('CRITICAL REGRESSION PIN: sidebarOpen defaults false, independent of sidebarExpanded, so the drawer is still closed below xl', () => {
      // The fix for the above must not just flip the bug the other way and
      // reopen the drawer by default below xl -- the two fields are
      // deliberately independent.
      const wrapper = mountLayout()
      const sidebar = wrapper.getComponent(CaseSidebarStub)
      expect(sidebar.classes()).toContain('max-md:-translate-y-full')
      expect(sidebar.classes()).toContain('md:max-xl:-translate-x-full')
    })

    it('collapses the sidebar to 0 width via sidebarExpanded, not sidebarOpen', async () => {
      const store = useViewerStore()
      store.sidebarExpanded = true
      const wrapper = mountLayout()
      const sidebar = wrapper.getComponent(CaseSidebarStub)
      expect(sidebar.classes()).not.toContain('xl:w-0')

      store.sidebarExpanded = false
      await wrapper.vm.$nextTick()
      expect(sidebar.classes()).toContain('xl:w-0')
      expect(sidebar.classes()).toContain('xl:border-0')

      // toggling sidebarOpen (the drawer field) must not affect any of this
      store.sidebarOpen = true
      await wrapper.vm.$nextTick()
      expect(sidebar.classes()).toContain('xl:w-0')
    })

    it('collapsed panels are also invisible at xl+, not just clipped -- otherwise ~10 links stay tabbable off-screen', async () => {
      const store = useViewerStore()
      store.sidebarExpanded = false
      store.contentOpen = false
      const wrapper = mountLayout()
      const sidebar = wrapper.getComponent(CaseSidebarStub)
      const content = wrapper.get('#case-content-panel')
      expect(sidebar.classes()).toContain('xl:invisible')
      expect(content.classes()).toContain('xl:invisible')

      store.sidebarExpanded = true
      store.contentOpen = true
      await wrapper.vm.$nextTick()
      expect(sidebar.classes()).toContain('xl:visible')
      expect(content.classes()).toContain('xl:visible')
    })

    it('does not force xl:overflow-hidden unconditionally on the sidebar -- only while collapsed', async () => {
      // xl:overflow-hidden merges onto CaseSidebar's own unconditional
      // overflow-y-auto (same DOM element, Vue merges parent + component
      // classes). Present at all times, it silently disables the case
      // list's own scrolling even while expanded -- clipping it with no
      // scrollbar at 200% zoom or a short viewport (§11).
      const store = useViewerStore()
      store.sidebarExpanded = true
      const wrapper = mountLayout()
      const sidebar = wrapper.getComponent(CaseSidebarStub)
      expect(sidebar.classes()).not.toContain('xl:overflow-hidden')

      store.sidebarExpanded = false
      await wrapper.vm.$nextTick()
      expect(sidebar.classes()).toContain('xl:overflow-hidden')
    })

    it('xl+: collapses the content column to 0 width via contentOpen, independent of the sidebar', async () => {
      const store = useViewerStore()
      store.contentOpen = true
      const wrapper = mountLayout()
      const content = wrapper.get('#case-content-panel')
      expect(content.classes()).toContain('xl:w-100')
      expect(content.classes()).not.toContain('xl:w-0')

      store.contentOpen = false
      await wrapper.vm.$nextTick()
      expect(content.classes()).toContain('xl:w-0')
      expect(content.classes()).toContain('xl:border-0')
      expect(content.classes()).not.toContain('xl:w-100')
    })
  })

  describe('tablet bottom sheet (design doc §10.2)', () => {
    it('defaults to a peek height, not half-screen, so it does not cover the stage on first paint', () => {
      const wrapper = mountLayout()
      const content = wrapper.get('#case-content-panel')
      expect(content.classes()).toContain('md:max-xl:max-h-20')
      expect(content.classes()).not.toContain('md:max-xl:max-h-[50dvh]')
    })

    it('the handle expands it to half-screen height when tapped, and back when tapped again', async () => {
      const wrapper = mountLayout()
      const handle = wrapper.get('button[aria-label="Expand content panel"]')
      expect(handle.attributes('aria-expanded')).toBe('false')

      await handle.trigger('click')
      const content = wrapper.get('#case-content-panel')
      expect(content.classes()).toContain('md:max-xl:max-h-[50dvh]')
      expect(content.classes()).not.toContain('md:max-xl:max-h-20')
      const expandedHandle = wrapper.get('button[aria-label="Collapse content panel"]')
      expect(expandedHandle.attributes('aria-expanded')).toBe('true')

      await expandedHandle.trigger('click')
      expect(wrapper.get('#case-content-panel').classes()).toContain('md:max-xl:max-h-20')
    })

    it('the handle only renders (as a flex box) at the tablet tier', () => {
      // hidden by default, `flex` only within the md..xl compound variant --
      // never visible/tappable at phone (no bottom sheet) or xl+ (its own
      // AppHeader button handles collapse there instead).
      const wrapper = mountLayout()
      const handle = wrapper.get('button[aria-label="Expand content panel"]')
      expect(handle.classes()).toContain('hidden')
      expect(handle.classes()).toContain('md:max-xl:flex')
    })

    it('is fixed to the bottom of the viewport only at the tablet tier', () => {
      const wrapper = mountLayout()
      const content = wrapper.get('#case-content-panel')
      expect(content.classes()).toContain('md:max-xl:fixed')
      expect(content.classes()).toContain('md:max-xl:bottom-0')
    })

    it('reserves space for its own peek height in <main>, so the peek never permanently covers content', () => {
      // The sheet is `fixed bottom-0`, outside <main>'s normal flow, so
      // without matching bottom padding its peek height (max-h-20 = 80px)
      // permanently hides whatever <main> would otherwise end on -- Task
      // 7's control bar.
      const wrapper = mountLayout()
      const main = wrapper.get('main')
      expect(main.classes()).toContain('md:max-xl:pb-20')
    })

    it('sits below the drawer scrim in stacking order, so it is dimmed and unclickable while the drawer is open', () => {
      // The scrim is a fixed z-20 layer (see the "insets the scrim" test
      // below). The sheet previously used z-30 -- *above* the scrim -- so
      // it stayed undimmed and interactive while the case-nav drawer was
      // supposedly a modal overlay.
      const wrapper = mountLayout()
      const content = wrapper.get('#case-content-panel')
      expect(content.classes()).toContain('md:max-xl:z-10')
      expect(content.classes()).not.toContain('md:max-xl:z-30')
    })

    it('the handle meets the 44px tap-target floor and a 3:1 non-text contrast on its only visual affordance', () => {
      // happy-dom can't measure rendered pixels or compute contrast against
      // a stylesheet, so this asserts the utilities that control both:
      // min-h-11 = 44px, and text-muted (6.36:1 on surface, tokens.test.ts
      // already proves this generically) in place of border-strong (a
      // re-derived 1.73:1 on surface -- under the 3:1 floor).
      const wrapper = mountLayout()
      const handle = wrapper.get('button[aria-label="Expand content panel"]')
      expect(handle.classes()).toContain('min-h-11')
      const indicator = handle.get('span')
      expect(indicator.classes()).toContain('bg-text-muted')
      expect(indicator.classes()).not.toContain('bg-border-strong')
    })
  })

  it('the tablet drawer runs flush to the viewport bottom, matching the scrim (no dead gap)', () => {
    // inset-y-14 insets both top AND bottom by 56px, leaving a 56px strip at
    // the bottom where the scrim (which correctly runs to bottom-0) shows
    // through undimmed by the drawer. Phone's top drawer already gets this
    // right with top-14/bottom-0; tablet's left drawer should match.
    const wrapper = mountLayout()
    const sidebar = wrapper.getComponent(CaseSidebarStub)
    expect(sidebar.classes()).toContain('md:max-xl:top-14')
    expect(sidebar.classes()).toContain('md:max-xl:bottom-0')
    expect(sidebar.classes()).not.toContain('md:max-xl:inset-y-14')
  })

  it('only renders the drawer overlay while the sidebar is explicitly open', async () => {
    const store = useViewerStore()
    store.sidebarOpen = false
    const wrapper = mountLayout()
    expect(wrapper.find('button[aria-label="Close case navigation"]').exists()).toBe(false)

    store.sidebarOpen = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[aria-label="Close case navigation"]').exists()).toBe(true)
  })

  it('clicking the overlay closes the sidebar', async () => {
    const store = useViewerStore()
    store.sidebarOpen = true
    const wrapper = mountLayout()
    await wrapper.get('button[aria-label="Close case navigation"]').trigger('click')
    expect(store.sidebarOpen).toBe(false)
  })

  it('insets the scrim below the header, so it never dims/blocks the header', async () => {
    // A `fixed inset-0` scrim paints over the header too: with the drawer
    // open the header looks dimmed and clicking the logo/About just closes
    // the drawer instead of navigating. top-14 matches AppHeader's own h-14.
    const store = useViewerStore()
    store.sidebarOpen = true
    const wrapper = mountLayout()
    const scrim = wrapper.get('button[aria-label="Close case navigation"]')
    expect(scrim.classes()).toContain('top-14')
    expect(scrim.classes()).not.toContain('inset-0')
  })

  it('has exactly one <main> landmark wrapping every region, with no <aside> mislabelling the copy', () => {
    const wrapper = mountLayout()
    const mains = wrapper.findAll('main')
    expect(mains).toHaveLength(1)
    expect(mains[0]!.attributes('id')).toBe('main-content')
    // A skip-link target needs to be programmatically focusable.
    expect(mains[0]!.attributes('tabindex')).toBe('-1')
    expect(mains[0]!.find('.stage-marker').exists()).toBe(true)
    expect(mains[0]!.find('.content-marker').exists()).toBe(true)
    expect(wrapper.find('aside').exists()).toBe(false)
  })

  it('gives the stage an accessible name', () => {
    const wrapper = mountLayout()
    const stage = wrapper.find('.stage-marker').element.closest('section')
    expect(stage?.getAttribute('aria-label')).toBeTruthy()
  })

  it('gives the stage a minimum height at tablet, so it cannot be flexed to 0', () => {
    // In a column flex layout with a shrink-0 sibling, flex-1 alone lets a
    // flex-basis-0 stage resolve to 0px once content exceeds the container
    // (negative free space defeats flex-grow). A min-height floors it.
    // Exact-token match, not a /min-h-\d/-shaped regex: that pattern is
    // satisfied by a stray `min-h-1` (4px) just as much as the intended
    // `min-h-100` (400px), so it would pass without actually pinning the
    // floor's value.
    const wrapper = mountLayout()
    const stage = wrapper.find('.stage-marker').element.closest('section')
    const classes = stage?.className.split(/\s+/).map(c => c.replace(/^tw:/, '')) ?? []
    expect(classes).toContain('md:max-xl:min-h-100')
  })

  it('forces the stage to an exact 1:1 square at phone, per design doc §10.3', () => {
    const wrapper = mountLayout()
    const stage = wrapper.find('.stage-marker').element.closest('section')
    expect(stage?.className).toContain('tw:max-md:aspect-square')
    // flex-none, not flex-1, at phone -- otherwise flex-grow sizing fights
    // the aspect ratio for the final height instead of yielding to it.
    expect(stage?.className).toContain('tw:max-md:flex-none')
  })

  it('has a skip link, as the very first focusable element, targeting #main-content', () => {
    const wrapper = mountLayout()
    const skipLink = wrapper.get('a[href="#main-content"]')
    expect(skipLink.text()).toMatch(/skip/i)
    // "First focusable element" -- must precede the header in DOM order.
    const html = wrapper.html()
    expect(html.indexOf('#main-content')).toBeLessThan(html.indexOf('<header'))
  })

  it('decides layout tiers purely in CSS: no window/matchMedia/userAgent probing', () => {
    // Regression guard for the global constraint this task is scoped around:
    // the old Vue 2 app measured panel height in JS and re-measured on
    // `updated()`, so the pre-rendered markup was phone-shaped for every
    // visitor until the bundle ran. Reads the raw SFC source (not the
    // compiled component) so a reintroduced `window.innerWidth` read would
    // fail this even if it were buried inside a computed property. Covers
    // every file this task has touched, not just this one -- the same
    // mistake in AppHeader, CaseSidebar, or the store would be just as much
    // a reintroduction of the bug this guards against. (CaseSidebar
    // deliberately uses `getComputedStyle(el).position` to gate its focus
    // trap -- that's a point-in-time read of what CSS already decided for
    // one element, not a duplicated pixel threshold, so it isn't in this
    // banned list; see the comment above `isDrawerMode` in CaseSidebar.vue.
    // Adding a third `position: fixed`-triggering tier this round didn't
    // change that reasoning: the gate still only asks "is CSS currently
    // treating this as a drawer", regardless of which edge it drops from.)
    const files = [
      '../src/layouts/DefaultLayout.vue',
      '../src/components/nav/AppHeader.vue',
      '../src/components/nav/CaseSidebar.vue',
      '../src/stores/viewer.ts',
    ]
    for (const file of files) {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      )
      expect(src, `${file}: window.innerWidth/outerWidth`).not.toMatch(/window\.(inner|outer)(Width|Height)/)
      expect(src, `${file}: matchMedia`).not.toMatch(/matchMedia/)
      expect(src, `${file}: navigator.userAgent`).not.toMatch(/navigator\.userAgent/)
      expect(src, `${file}: ResizeObserver`).not.toMatch(/ResizeObserver/)
    }
  })
})
