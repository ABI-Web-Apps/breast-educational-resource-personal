import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import TourLauncher from '../src/components/tour/TourLauncher.vue'
import { TOUR_SEEN_KEY, useTourStore } from '../src/stores/tour'

describe('TourLauncher', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('appears on a first visit', () => {
    expect(mount(TourLauncher).find('[data-tour-launcher]').exists()).toBe(true)
  })

  it('does not appear once the tour has been seen', () => {
    localStorage.setItem(TOUR_SEEN_KEY, '1')
    expect(mount(TourLauncher).find('[data-tour-launcher]').exists()).toBe(false)
  })

  it('"Not now" dismisses it permanently', async () => {
    const w = mount(TourLauncher)
    await w.get('[data-tour-dismiss]').trigger('click')
    expect(w.find('[data-tour-launcher]').exists()).toBe(false)
    expect(useTourStore().hasSeen).toBe(true)
  })

  it('"Take the tour" emits start', async () => {
    const w = mount(TourLauncher)
    await w.get('[data-tour-take]').trigger('click')
    expect(w.emitted('start')).toHaveLength(1)
  })

  it('clears the tablet bottom sheet and the phone prev/next cards', () => {
    // The app already owns its bottom-right corner at every tier.
    const w = mount(TourLauncher)
    const cls = w.get('[data-tour-launcher]').classes()
    expect(cls).toContain('md:max-xl:bottom-24')
    expect(cls).toContain('max-md:bottom-4')
  })

  it('hides itself while the tour is running', async () => {
    const store = useTourStore()
    const w = mount(TourLauncher)
    store.start('wide', 14, '/')
    await w.vm.$nextTick()
    expect(w.find('[data-tour-launcher]').exists()).toBe(false)
  })
})
