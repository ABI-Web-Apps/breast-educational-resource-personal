import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CasePanels from '../src/components/stage/CasePanels.vue'
import { getCase } from '../src/content/cases'

const CopperStageStub = {
  props: ['slug', 'group', 'panelLabel', 'lesionSliceIndex', 'modality', 'compact', 'panelId', 'loadEnabled'],
  emits: ['settled'],
  template: '<div data-stub-stage :data-panel-id="panelId" :data-load-enabled="loadEnabled" />',
}

function mountPanels() {
  return mount(CasePanels, {
    props: { case: getCase('the-breast')!, modalityId: 'anatomy' },
    global: {
      stubs: { CopperStage: CopperStageStub, PanelTabs: { template: '<div />' } },
    },
  })
}

function enabledMap(wrapper: ReturnType<typeof mountPanels>) {
  return Object.fromEntries(
    wrapper.findAll('[data-stub-stage]').map(el => [
      el.attributes('data-panel-id'),
      el.attributes('data-load-enabled'),
    ]),
  )
}

describe('CasePanels staged loading', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('navigateTo', vi.fn())
  })

  it('enables only the focused panel on first paint', () => {
    const wrapper = mountPanels()
    const map = enabledMap(wrapper)
    expect(map.anatomy).toBe('true')
    expect(map.mammogram).toBe('false')
    expect(map.mri).toBe('false')
  })

  it('releases the remaining panels once the focused one settles', async () => {
    const wrapper = mountPanels()
    const focused = wrapper.findAll('[data-stub-stage]')
      .find(el => el.attributes('data-panel-id') === 'anatomy')!
    await focused.getComponent(CopperStageStub).vm.$emit('settled')
    await wrapper.vm.$nextTick()

    const map = enabledMap(wrapper)
    expect(map.mammogram).toBe('true')
    expect(map.mri).toBe('true')
  })

  it('releases the remaining panels after the safety timeout, even with no settle', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanels()
    vi.advanceTimersByTime(15_000)
    await wrapper.vm.$nextTick()
    expect(enabledMap(wrapper).mri).toBe('true')
    vi.useRealTimers()
  })

  it('never re-locks a panel once released', async () => {
    const wrapper = mountPanels()
    const focused = wrapper.findAll('[data-stub-stage]')
      .find(el => el.attributes('data-panel-id') === 'anatomy')!
    await focused.getComponent(CopperStageStub).vm.$emit('settled')
    await wrapper.setProps({ modalityId: 'mri' })
    expect(enabledMap(wrapper).anatomy).toBe('true')
  })

  /**
   * I4: `pageKey.ts` pins every case page to one constant key, so this
   * component never remounts across cases -- only re-props. Before the fix,
   * `released` was a one-way latch for the whole component lifetime, so
   * once the FIRST case settled, staged loading silently stopped applying to
   * every case after it (the common prev/next path), starting all three
   * multi-megabyte downloads at once again. Changing `case` (not just
   * `modalityId`) must re-arm the gate.
   */
  it('re-gates the non-focused panels when the case itself changes, after already having released once', async () => {
    const wrapper = mountPanels()
    const focused = wrapper.findAll('[data-stub-stage]')
      .find(el => el.attributes('data-panel-id') === 'anatomy')!
    await focused.getComponent(CopperStageStub).vm.$emit('settled')
    expect(enabledMap(wrapper).mri).toBe('true') // released once, as before

    await wrapper.setProps({ case: getCase('density-a')!, modalityId: 'anatomy' })
    const map = enabledMap(wrapper)
    expect(map.anatomy).toBe('true')
    expect(map.mammogram).toBe('false')
    expect(map.mri).toBe('false')
  })

  it('re-arms the safety timeout when the case changes', async () => {
    vi.useFakeTimers()
    const wrapper = mountPanels()
    vi.advanceTimersByTime(15_000)
    await wrapper.vm.$nextTick()
    expect(enabledMap(wrapper).mri).toBe('true') // released by the first timeout

    await wrapper.setProps({ case: getCase('density-a')!, modalityId: 'anatomy' })
    expect(enabledMap(wrapper).mri).toBe('false') // re-gated

    vi.advanceTimersByTime(15_000)
    await wrapper.vm.$nextTick()
    expect(enabledMap(wrapper).mri).toBe('true') // re-armed timeout fires again
    vi.useRealTimers()
  })
})
