import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MyMriViewer from '../src/components/myMri/MyMriViewer.vue'
import { MY_MRI_COPY } from '../src/content/myMri'
import type { FindingSummary } from '../src/myMri/useMyMriSession'

/** The scene itself is covered by useMyMriScene.test.ts; this is the chrome around it. */
const scene = {
  status: ref<'loading' | 'ready' | 'error'>('ready'),
  error: ref<string | null>(null),
  resetView: vi.fn(),
}
const useMyMriScene = vi.fn((_host: unknown, _sources: unknown) => scene)
vi.mock('../src/myMri/useMyMriScene', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/myMri/useMyMriScene')>()),
  useMyMriScene: (host: unknown, sources: unknown) => useMyMriScene(host, sources),
}))

const FINDINGS: FindingSummary[] = [
  { label: 'Finding 1', channel: 1, color: '#ff7043' },
  { label: 'Finding 2', channel: 2, color: '#42a5f5' },
]
const mountViewer = (findings = FINDINGS) => mount(MyMriViewer, {
  props: { mri: '/api/patients/a/sub-1/mri', mask: '/api/patients/a/sub-1/mask.glb', findings },
})

describe('MyMriViewer', () => {
  beforeEach(() => {
    scene.status.value = 'ready'
    scene.error.value = null
    scene.resetView.mockClear()
    useMyMriScene.mockClear()
  })

  it('hands the scene its MRI, mask and findings', () => {
    mountViewer()
    expect(useMyMriScene).toHaveBeenCalledWith(expect.anything(), {
      mri: '/api/patients/a/sub-1/mri', mask: '/api/patients/a/sub-1/mask.glb', findings: FINDINGS,
    })
  })

  it('shows a legend entry per finding, with its colour', () => {
    const legend = mountViewer().get(`ul[aria-label="${MY_MRI_COPY.viewerLegendLabel}"]`)
    const items = legend.findAll('li')
    expect(items.map(i => i.text())).toEqual(['Finding 1', 'Finding 2'])
    expect(items[0]!.get('span').attributes('style')).toContain('background-color: #ff7043')
    expect(items[1]!.get('span').attributes('style')).toContain('background-color: #42a5f5')
  })

  it('hides the legend without findings', () => {
    expect(mountViewer([]).find('ul').exists()).toBe(false)
  })

  it('shows the controls hint', () => {
    expect(mountViewer().text()).toContain('drag · right-drag · scroll')
  })

  it('resets the view from the Reset button, which waits for the scene', async () => {
    scene.status.value = 'loading'
    const wrapper = mountViewer()
    const reset = wrapper.get(`button[aria-label="${MY_MRI_COPY.viewerResetLabel}"]`)
    expect(reset.text()).toBe('Reset')
    expect(reset.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[role="status"]').text()).toContain(MY_MRI_COPY.loading)

    scene.status.value = 'ready'
    await nextTick()
    expect(reset.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    await reset.trigger('click')
    expect(scene.resetView).toHaveBeenCalledTimes(1)
  })

  it('emits a load error and shows it over the canvas', async () => {
    scene.status.value = 'loading'
    const wrapper = mountViewer()
    scene.error.value = 'Your scan could not be loaded.'
    scene.status.value = 'error'
    await nextTick()
    expect(wrapper.emitted('error')).toEqual([['Your scan could not be loaded.']])
    expect(wrapper.get('[role="alert"]').text()).toBe('Your scan could not be loaded.')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
