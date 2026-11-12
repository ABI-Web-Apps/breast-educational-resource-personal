import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TourCard from '../src/components/tour/TourCard.vue'

function mountCard(props: Partial<InstanceType<typeof TourCard>['$props']> = {}) {
  return mount(TourCard, {
    props: {
      title: 'A title',
      body: 'Some body copy',
      stepNumber: 1,
      stepCount: 14,
      chapterLabel: 'The layout',
      atEnd: false,
      rect: null,
      placement: 'center',
      ...props,
    },
  })
}

/**
 * I5: stepping the tour swaps the title/body with no re-focus, and the
 * rail's own `role="status"` only announces "n / N", not what changed. This
 * pins that the title+body are wrapped in a polite live region, so screen
 * readers announce the new step, while the existing role="dialog" and
 * aria-labelledby wiring (needed for the initial focus-in announcement)
 * stays intact.
 */
describe('TourCard accessibility', () => {
  it('wraps the title and body in a polite live region', () => {
    const wrapper = mountCard()
    const live = wrapper.get('[aria-live="polite"]')
    expect(live.find('h2').exists()).toBe(true)
    expect(live.find('p').text()).toBe('Some body copy')
  })

  it('keeps role=dialog and aria-labelledby on the outer card, not the live region', () => {
    const wrapper = mountCard()
    const dialog = wrapper.get('[role="dialog"]')
    const labelledBy = dialog.attributes('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(wrapper.get(`#${labelledBy}`).element.tagName).toBe('H2')
  })

  it('re-renders the live region\'s content when the step changes', async () => {
    const wrapper = mountCard()
    await wrapper.setProps({ title: 'Second title', body: 'Second body' })
    const live = wrapper.get('[aria-live="polite"]')
    expect(live.find('h2').text()).toBe('Second title')
    expect(live.find('p').text()).toBe('Second body')
  })
})
