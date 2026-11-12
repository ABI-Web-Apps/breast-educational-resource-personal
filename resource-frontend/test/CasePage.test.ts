import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { layOutCopy } from '../src/components/content/groupSentences'
import StageControls from '../src/components/stage/StageControls.vue'
import { getModality } from '../src/content/cases'
import CasePage from '../src/pages/CasePage.vue'
import { resolvePath } from '../src/navigation/routes'
import type { PageRoute } from '../src/navigation/routes'

// The page is handed its route by App.vue; each test picks the case.
let currentRoute: PageRoute

function stubRoute(params: { slug: string, modality: string | undefined }) {
  currentRoute = {
    path: `/${params.slug}${params.modality ? `/${params.modality}` : ''}`,
    name: 'case',
    params,
  }
}

const DefaultLayoutStub = {
  template: `
    <div>
      <div class="heading-slot"><slot name="heading" /></div>
      <div class="stage-slot"><slot name="stage" /></div>
      <div class="content-slot"><slot name="content" /></div>
    </div>
  `,
}

// In-app links, stubbed the way CaseSidebar.test.ts stubs them.
const AppLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

// Task 7 replaced the #stage placeholder with the real CopperStage, which
// dynamically imports copper3d in onMounted and drives a WebGL canvas --
// none of which plain Vitest/happy-dom can do (no WebGL) or should try to
// (see test/*.test.ts's testing notes: don't fake a passing render
// test). Task 8 gave CopperStage a `slug` prop (scene namespacing) and
// widened `modality` from a bare ModalityId to the full Modality object
// (asset/viewPreset paths). Stubbed here, the only thing worth asserting is
// that the page still resolves and forwards the right slug/modality -- the
// same per-modality wiring the old placeholder text used to prove, just via
// props instead of display text now that #stage renders a real viewer.
// Task 10 added `group` and `lesionSliceIndex`: the stage decides which §7
// transition a navigation gets (density morph vs. modality flight) and
// whether "Locate lesion" has anywhere to glide to. Controller correction
// C7 chose those two fields over handing it the whole `Case`.
// Task 5 (three-up plan) moved the stage, the slot strip and the control
// bars all inside CasePanels, so the page's #stage slot now renders that
// one component. What is left for the page to get right is which case and
// which modality it resolves and hands over, which is what this stub
// exposes. CasePanels.test.ts owns everything downstream of it.
const CasePanelsStub = {
  props: ['case', 'modalityId'],
  // `case` is a reserved word, so a bare `case.slug` in a template
  // expression is a syntax error -- reach it through `$props`.
  template: `<div
    class="case-panels-stub"
    :data-slug="$props.case.slug"
    :data-group="$props.case.group"
  >{{ modalityId }}</div>`,
}

function mountPage() {
  return mount(CasePage, {
    props: { route: currentRoute },
    global: {
      stubs: { DefaultLayout: DefaultLayoutStub, AppLink: AppLinkStub, CasePanels: CasePanelsStub },
    },
  })
}

describe('case page', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders heading/stage/content into the layout\'s slots, falling back to the first modality', () => {
    stubRoute({ slug: 'density-d', modality: undefined })
    const wrapper = mountPage()

    // The stage slot renders CasePanels (stubbed above); what matters here
    // is that it receives the resolved case and the resolved modality id.
    expect(wrapper.find('.stage-slot .case-panels-stub').text()).toBe('anatomy')
    expect(wrapper.find('.stage-slot .case-panels-stub').attributes('data-slug')).toBe('density-d')
    // Case heading lives in its own #heading slot (design doc §10.1's ASCII
    // puts it atop the stage column, not the content column).
    expect(wrapper.find('.heading-slot h1').text()).toBe('Extremely dense')
    expect(wrapper.find('.content-slot h1').exists()).toBe(false)
  })

  it('honours an explicit modality in the URL instead of the fallback', () => {
    stubRoute({ slug: 'cancer-dcis', modality: 'mri' })
    const wrapper = mountPage()

    expect(wrapper.find('.heading-slot h1').text()).toBe('DCIS')
    // Client feedback item 2 gave every lesion case an anatomy modality, so
    // anatomy is now cancer-dcis's FIRST modality -- this proves the
    // explicit `mri` param still wins over that fallback.
    expect(wrapper.find('.stage-slot .case-panels-stub').text()).toBe('mri')
  })

  it('renders the frozen medical copy for the resolved modality, byte for byte', () => {
    stubRoute({ slug: 'benign-cyst', modality: 'ultrasound' })
    const wrapper = mountPage()
    const expected = getModality('benign-cyst', 'ultrasound')!.text
    const { lede, body } = layOutCopy(expected)

    /*
     * `[data-modality-copy]`, not `.prose-medical > p`.
     *
     * The column now opens with a modality overline (an interface word, not
     * clinical copy) and the remaining sentences are laid out as BALANCED
     * paragraphs rather than one block, so neither "the first <p> is the
     * lede" nor a 1:1 mapping onto splitLede's output holds any more. The
     * attribute marks exactly the nodes that carry frozen copy, and the
     * concatenation below is the assertion that actually matters: whatever
     * the layout decides, not one character may move.
     */
    const paragraphs = wrapper.findAll('.content-slot [data-modality-copy]')
    expect(paragraphs.map(p => p.element.innerHTML))
      .toEqual([lede, ...body].filter(Boolean))
    expect(paragraphs.map(p => p.element.innerHTML).join(' ').replace(/\s+/g, ' '))
      .toBe(expected.replace(/\s+/g, ' '))
  })

  it('names the panel the copy belongs to, in that modality\'s ink', () => {
    stubRoute({ slug: 'benign-cyst', modality: 'ultrasound' })
    const overline = mountPage().get('.content-slot [data-modality-overline]')

    expect(overline.text()).toBe(getModality('benign-cyst', 'ultrasound')!.label)
    expect(overline.classes()).toContain('text-ultrasound-ink')
  })

  /**
   * The control bar is no longer this page's business.
   *
   * It used to render into the layout's `#controls` slot, a sibling of the
   * stage slot, so this page -- their nearest common ancestor -- had to own
   * the state between them. Each stage now renders its own bar under its own
   * canvas, because the three-up layout gives every panel one. What is left
   * for the page to get right is the lesion index it hands the stage, and
   * that is what these two assert. `CopperStage.test.ts` covers the bar
   * itself.
   */
  it('renders no control bar of its own', () => {
    stubRoute({ slug: 'density-d', modality: undefined })
    const wrapper = mountPage()

    expect(wrapper.text()).not.toContain('Reset view')
    expect(wrapper.findComponent(StageControls).exists()).toBe(false)
  })

  /**
   * The lesion index is no longer computed here: three-up shows three
   * modalities at once, so "which slice holds this lesion" is a per-panel
   * question. `CasePanels` asks `lesionSliceIndexFor` per slot, and
   * `CasePanels.test.ts` pins that. What the page still owes is the case
   * itself, unmodified.
   */
  it('gives CasePanels the case its §7 transitions depend on', () => {
    stubRoute({ slug: 'cancer-dcis', modality: 'mri' })
    expect(mountPage().find('.case-panels-stub').attributes('data-group')).toBe('cancer')

    stubRoute({ slug: 'density-d', modality: 'mri' })
    expect(mountPage().find('.case-panels-stub').attributes('data-group')).toBe('density')
  })

  /**
   * The 404 rule lives in the route table now, which resolves EVERY
   * navigation -- the page instance is shared by all cases, so a check in
   * its setup would only ever see the first case of a session.
   */
  it('the route table 404s disabled and unknown cases but not enabled ones', () => {
    const page = (path: string) => {
      const resolved = resolvePath(path)
      return 'route' in resolved ? resolved.route.name : 'redirect'
    }
    expect(page('/the-breast')).toBe('case')
    expect(page('/benign-calcifications')).toBe('not-found')
    expect(page('/nope')).toBe('not-found')
  })
})
