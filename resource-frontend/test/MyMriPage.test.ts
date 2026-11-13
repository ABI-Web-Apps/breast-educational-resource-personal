import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
/** The viewer's own scene is covered by useMyMriScene.test.ts; here it only reports. */
let viewerMounts = 0
const MyMriViewerStub = {
  name: 'MyMriViewer',
  props: ['mri', 'mask', 'findings'],
  emits: ['retry'],
  mounted() { viewerMounts++ },
  template: '<div data-slot="my-mri-viewer" />',
}
const MyMriReportStub = {
  name: 'MyMriReport',
  props: ['urlFor', 'cohort', 'withReload'],
  template: '<div data-slot="my-mri-report" />',
}
const enc = new TextEncoder()
const completeStream = () => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    c.enqueue(enc.encode(['event: complete', 'data: {"assay":"a-1","cases":["sub-1"]}', '', ''].join('\n')))
    c.close()
  },
}), { status: 200 })
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

/** Route fetch by URL: tool-config streams, findings answers with `findings`. */
function stubBackend(findings: () => Response, toolConfig: () => Response = completeStream) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.includes('tool-config') ? toolConfig() : findings()))
}
const noFindings = () => jsonRes(404, { detail: { code: 'no_findings', summary: 'none' } })
const mounted: { unmount: () => void }[] = []
const track = <T extends { unmount: () => void }>(w: T): T => { mounted.push(w); return w }
afterEach(async () => {
  // Unmount first so any in-flight request is aborted, then let it settle.
  mounted.splice(0).forEach(w => w.unmount())
  await flushPromises()
  vi.unstubAllGlobals()
})

const route: PageRoute = { path: '/my-mri', name: 'my-mri', params: {} }

describe('MyMriPage', () => {
  beforeEach(() => { setActivePinia(createPinia()); stubBackend(noFindings) })
  const mountPage = () => track(mount(MyMriPage, {
    props: { route },
    global: { stubs: { DefaultLayout: DefaultLayoutStub, MyMriViewer: MyMriViewerStub, MyMriReport: MyMriReportStub } },
  }))

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

describe('MyMriPage session states', () => {
  beforeEach(() => { setActivePinia(createPinia()) })
  const mountPage = () => track(mount(MyMriPage, {
    props: { route },
    global: { stubs: { DefaultLayout: DefaultLayoutStub, MyMriViewer: MyMriViewerStub, MyMriReport: MyMriReportStub } },
  }))

  it('shows loading text in both columns, then the placeholders when ready', async () => {
    stubBackend(noFindings)
    const wrapper = mountPage()
    expect(wrapper.findAll('[data-state="loading"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('Loading your scan')
    await flushPromises()
    expect(wrapper.find('[data-state]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="my-mri-viewer"]').exists()).toBe(true)
    expect(wrapper.find('[data-slot="my-mri-report"]').exists()).toBe(true)
  })

  it('shows the backend summary and a Try again button on error, and retries', async () => {
    let attempt = 0
    stubBackend(noFindings, () => (attempt++ === 0
      ? jsonRes(400, { detail: { step: 'minio', summary: 'Dataset missing', detail: 'x' } })
      : completeStream()))
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.findAll('[data-state="error"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('Dataset missing')
    await wrapper.findAll('button').find(b => b.text() === 'Try again')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-state]').exists()).toBe(false)
  })

  it('announces the session state from one live region only', async () => {
    stubBackend(noFindings, () => jsonRes(400, { detail: { step: 'minio', summary: 'Dataset missing', detail: 'x' } }))
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-state="error"]')).toHaveLength(2)
  })

  it('hands the viewer the patient MRI, mask and findings once ready', async () => {
    stubBackend(() => jsonRes(200, { findings: [
      { label: 'Finding 1', lesion: { channel: 1, color: '#ff7043' } },
    ] }))
    const wrapper = mountPage()
    expect(wrapper.findComponent({ name: 'MyMriViewer' }).exists()).toBe(false)
    await flushPromises()
    const viewer = wrapper.getComponent({ name: 'MyMriViewer' })
    expect(viewer.props('mri')).toMatch(/\/api\/patients\/a-1\/sub-1\/mri$/)
    expect(viewer.props('mask')).toMatch(/\/api\/patients\/a-1\/sub-1\/mask\.glb$/)
    expect(viewer.props('findings')).toEqual([{ label: 'Finding 1', channel: 1, color: '#ff7043' }])
  })

  it('retries only the viewer when the viewer asks, leaving the session and report alone', async () => {
    stubBackend(noFindings)
    const wrapper = mountPage()
    await flushPromises()
    const fetches = vi.mocked(fetch).mock.calls.length
    const mountsBefore = viewerMounts
    wrapper.getComponent({ name: 'MyMriViewer' }).vm.$emit('retry')
    await flushPromises()
    expect(viewerMounts).toBe(mountsBefore + 1)
    // One findings request checks the backend still knows the assay; with it
    // loaded (no_findings is an answer, not a failure), nothing is re-posted.
    const urls = vi.mocked(fetch).mock.calls.slice(fetches).map(([url]) => String(url))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/\/api\/patients\/a-1\/sub-1\/findings$/)
    expect(wrapper.find('[data-state]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="my-mri-report"]').exists()).toBe(true)
  })

  it('re-posts the config once when the viewer retries after a backend restart, then rebuilds it', async () => {
    // A restarted backend has forgotten the assay: every patient route answers
    // 409 until the config is posted again.
    let restarted = false
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('tool-config')) {
        calls.push(`tool-config with ${viewerMounts} viewer mounts`)
        restarted = false
        return completeStream()
      }
      calls.push('findings')
      return restarted ? jsonRes(409, { detail: { code: 'assay_not_loaded', summary: 'Reload' } }) : noFindings()
    }))
    const wrapper = mountPage()
    await flushPromises()
    const mountsBefore = viewerMounts
    calls.length = 0
    restarted = true
    wrapper.getComponent({ name: 'MyMriViewer' }).vm.$emit('retry')
    await flushPromises()
    expect(calls).toEqual(['findings', `tool-config with ${mountsBefore} viewer mounts`, 'findings'])
    expect(viewerMounts).toBe(mountsBefore + 1)
    expect(wrapper.find('[data-state]').exists()).toBe(false)
  })

  it('still rebuilds the viewer when the backend check before a retry fails', async () => {
    stubBackend(noFindings)
    const wrapper = mountPage()
    await flushPromises()
    const mountsBefore = viewerMounts
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    wrapper.getComponent({ name: 'MyMriViewer' }).vm.$emit('retry')
    await flushPromises()
    expect(viewerMounts).toBe(mountsBefore + 1)
    expect(wrapper.find('[data-state]').exists()).toBe(false)
  })

  it('shows the colour sentence once findings are loaded', async () => {
    stubBackend(() => jsonRes(200, { findings: [
      { label: 'Finding 1', lesion: { channel: 1, color: '#ff7043' } },
      { label: 'Finding 2', lesion: { channel: 2, color: '#42a5f5' } },
    ] }))
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('.content-slot').text()).toContain('orange is Finding 1, blue is Finding 2')
  })

  it('renders a finding with no colour, naming it grey as the legend and mesh draw it', async () => {
    stubBackend(() => jsonRes(200, { findings: [
      { label: 'Finding 1', lesion: { channel: 1, color: '#ff7043' } },
      { label: 'Finding 2', lesion: { channel: 2, color: null } },
    ] }))
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.get('.content-slot').text()).toContain('orange is Finding 1, grey is Finding 2')
    expect(wrapper.getComponent({ name: 'MyMriViewer' }).props('findings')).toEqual([
      { label: 'Finding 1', channel: 1, color: '#ff7043' },
      { label: 'Finding 2', channel: 2, color: '#94a3b8' },
    ])
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
    // The neutral grey a finding without a usable colour is drawn in.
    expect(colourSentence([{ label: 'X', color: '#94a3b8' }])).toBe('grey is X')
    expect(colourSentence([{ label: 'X', color: null }, { label: 'Y', color: 'red' }])).toBe('grey is X, grey is Y')
    expect(colourSentence([])).toBe('')
    expect(MY_MRI_COPY.subline('sub-2')).toBe('Patient sub-2 · contrast phase 1')
  })
})

describe('MyMriPage inside the real layout', () => {
  beforeEach(() => { setActivePinia(createPinia()); stubBackend(noFindings) })

  it('puts heading, stage columns and panel copy in their slots, with a non-square stage', () => {
    const wrapper = track(mount(MyMriPage, {
      props: { route },
      global: {
        stubs: {
          AppHeader: { template: '<header />' },
          CaseSidebar: { template: '<nav />' },
          TourLauncher: true,
          TourLayer: true,
          MyMriViewer: MyMriViewerStub,
        },
      },
    }))
    const stage = wrapper.get('[data-stage-column] section')
    expect(stage.attributes('aria-label')).toBe('Your MRI scan and report')
    expect(stage.classes()).not.toContain('max-md:aspect-square')
    expect(stage.text()).toContain('3D view')
    expect(stage.text()).toContain('Report')
    expect(wrapper.get('[data-stage-column] h1').text()).toBe('Your MRI scan')
    expect(wrapper.get('#case-content-panel').text()).toContain("WHAT YOU'RE SEEING")
  })
})
