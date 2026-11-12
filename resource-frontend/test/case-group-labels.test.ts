import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import CaseHeader from '../src/components/content/CaseHeader.vue'
import CaseSidebar from '../src/components/nav/CaseSidebar.vue'
import { CASE_GROUP_LABEL, getCase } from '../src/content/cases'
import type { CaseGroup } from '../src/content/types'

const AppLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

/**
 * Client feedback: "There are some minor consistency aspects". CaseHeader's
 * above-the-title eyebrow, CaseSidebar's nav-group heading, and CaseNav's
 * prev/next overline used to type this label out three separate times --
 * 'Benign Condition' (singular) in CaseHeader disagreed with 'Benign
 * Conditions' (plural) in the other two. Both remaining places now read the
 * one CASE_GROUP_LABEL map from content/cases.ts; this test fails if either
 * goes back to a hand-typed literal that drifts from it.
 *
 * CaseNav is the third place and no longer shows the group at all: its
 * overline became the SLOT, so that pressing next -- which now steps
 * anatomy -> mammogram -> MRI -> next case -- says which view it is stepping
 * to. Its own drift guard lives in CaseNav.test.ts.
 */
describe('the case group label agrees everywhere it is shown', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const REPRESENTATIVE: Record<Exclude<CaseGroup, 'overview'>, string> = {
    density: 'density-a',
    benign: 'benign-cyst',
    cancer: 'cancer-dcis',
  }

  it('CaseHeader renders CASE_GROUP_LABEL, not a hand-typed copy', () => {
    for (const [group, slug] of Object.entries(REPRESENTATIVE) as [Exclude<CaseGroup, 'overview'>, string][]) {
      const wrapper = mount(CaseHeader, { props: { case: getCase(slug)! } })
      expect(wrapper.text()).toContain(CASE_GROUP_LABEL[group])
    }
  })

  it('CaseSidebar\'s three group headings are exactly CASE_GROUP_LABEL\'s values, in cases.ts order', () => {
    const wrapper = mount(CaseSidebar, { global: { stubs: { AppLink: AppLinkStub } } })
    expect(wrapper.findAll('h2').map(h => h.text())).toEqual([
      CASE_GROUP_LABEL.density,
      CASE_GROUP_LABEL.benign,
      CASE_GROUP_LABEL.cancer,
    ])
  })
})
