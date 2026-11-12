import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { getCase } from '../src/content/cases'
import CaseHeader from '../src/components/content/CaseHeader.vue'

describe('CaseHeader', () => {
  it('renders the group label and the heading', () => {
    const wrapper = mount(CaseHeader, { props: { case: getCase('density-c')! } })
    expect(wrapper.text()).toContain('Breast Density')
    expect(wrapper.text()).toContain('Heterogeneously dense')
  })

  it('renders no BI-RADS badge (client feedback item 3)', () => {
    for (const slug of ['the-breast', 'density-a', 'density-d', 'cancer-dcis']) {
      const wrapper = mount(CaseHeader, { props: { case: getCase(slug)! } })
      expect(wrapper.text()).not.toMatch(/BI-?RADS/i)
    }
  })

  it('renders no reference-density line (client feedback item 3)', () => {
    for (const slug of ['the-breast', 'cancer-dcis', 'benign-cyst']) {
      const wrapper = mount(CaseHeader, { props: { case: getCase(slug)! } })
      expect(wrapper.text()).not.toMatch(/Reference density/i)
    }
  })
})
