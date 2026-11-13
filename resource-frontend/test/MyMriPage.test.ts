import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { MY_MRI_COPY, colourSentence } from '../src/content/myMri'
import { getToolConfig } from '../src/myMri/config'
import MyMriPage from '../src/pages/MyMriPage.vue'
import type { PageRoute } from '../src/navigation/routes'

const DefaultLayoutStub = {
  template: `
    <div>
      <div class="heading-slot"><slot name="heading" /></div>
      <div class="stage-slot"><slot name="stage" /></div>
      <div class="content-slot"><slot name="content" /></div>
    </div>
  `,
}
const route: PageRoute = { path: '/my-mri', name: 'my-mri', params: {} }

describe('MyMriPage', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  const mountPage = () => mount(MyMriPage, {
    props: { route },
    global: { stubs: { DefaultLayout: DefaultLayoutStub } },
  })

  it('renders the heading with the cohort from the config', () => {
    const heading = mountPage().get('.heading-slot')
    expect(heading.text()).toContain('MY MRI')
    expect(heading.get('h1').text()).toBe('Your MRI scan')
    expect(heading.text()).toContain('Patient sub-1 · contrast phase 1')
  })

  it('renders two stage columns', () => {
    const stage = mountPage().get('.stage-slot')
    expect(stage.text()).toContain('3D view')
    expect(stage.text()).toContain('Report')
  })

  it('renders the right-panel copy', () => {
    const text = mountPage().get('.content-slot').text()
    expect(text).toContain("WHAT YOU'RE SEEING")
    expect(text).toContain('A dash (—) means')
  })

  it('omits the colour-matching paragraph while there are no findings', () => {
    expect(mountPage().get('.content-slot').text()).not.toContain('Each colour matches')
  })
})

describe('config and copy', () => {
  it('bundles the tool config', () => {
    expect(getToolConfig().assay_info.cohorts[0]).toBe('sub-1')
    expect(getToolConfig().assay_info.datasets[0]!.sample_type).toEqual(
      ['registration_1_nrrd', 'researcher_manual_LPS_nii', 'findings_json'])
  })
  it('colourSentence names colours from data', () => {
    expect(colourSentence([{ label: 'Finding 1', color: '#ff7043' }, { label: 'Finding 2', color: '#42a5f5' }]))
      .toBe('orange is Finding 1, blue is Finding 2')
    expect(colourSentence([{ label: 'X', color: '#123456' }])).toBe('this colour is X')
    expect(colourSentence([])).toBe('')
    expect(MY_MRI_COPY.subline('sub-2')).toBe('Patient sub-2 · contrast phase 1')
  })
})
