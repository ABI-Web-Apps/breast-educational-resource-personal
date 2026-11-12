import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TourCard from '../src/components/tour/TourCard.vue'
import TourRail from '../src/components/tour/TourRail.vue'
import TourSpotlight from '../src/components/tour/TourSpotlight.vue'
import { TOUR_CHAPTERS } from '../src/content/tour'

// right/bottom included: a real getBoundingClientRect() always computes
// them (right = left + width, bottom = top + height); a plain object
// literal cast to DOMRect does not unless they're spelled out.
const rect = { top: 100, left: 200, width: 300, height: 150, right: 500, bottom: 250 } as DOMRect

/** Runs `fn` under a fixed viewport size, then restores whatever was there. */
function withViewport<T>(width: number, height: number, fn: () => T): T {
  const ow = globalThis.innerWidth
  const oh = globalThis.innerHeight
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  try {
    return fn()
  } finally {
    vi.stubGlobal('innerWidth', ow)
    vi.stubGlobal('innerHeight', oh)
  }
}

describe('TourSpotlight', () => {
  it('positions itself over the target rect', () => {
    const w = mount(TourSpotlight, { props: { rect } })
    const style = w.get('[data-tour-halo]').attributes('style')!
    expect(style).toContain('top: 100px')
    expect(style).toContain('left: 200px')
    expect(style).toContain('width: 300px')
    expect(style).toContain('height: 150px')
  })

  it('renders nothing when there is no target (a centred step)', () => {
    const w = mount(TourSpotlight, { props: { rect: null } })
    expect(w.find('[data-tour-halo]').exists()).toBe(false)
  })
})

const cardProps = {
  title: 'Rotate the model', body: 'demo copy',
  stepNumber: 8, stepCount: 14, chapterLabel: 'Interacting',
  atEnd: false, rect, placement: 'right' as const,
}

describe('TourCard', () => {
  it('shows the chapter, the position and the copy', () => {
    const w = mount(TourCard, { props: cardProps })
    expect(w.text()).toContain('Interacting')
    expect(w.text()).toContain('8')
    expect(w.text()).toContain('14')
    expect(w.text()).toContain('demo copy')
  })

  it('emits next, back and exit', async () => {
    const w = mount(TourCard, { props: cardProps })
    await w.get('[data-tour-next]').trigger('click')
    await w.get('[data-tour-back]').trigger('click')
    await w.get('[data-tour-exit]').trigger('click')
    expect(w.emitted('next')).toHaveLength(1)
    expect(w.emitted('back')).toHaveLength(1)
    expect(w.emitted('exit')).toHaveLength(1)
  })

  it('labels the last step Finish rather than Next', () => {
    const w = mount(TourCard, { props: { ...cardProps, atEnd: true } })
    expect(w.get('[data-tour-next]').text()).toBe('Finish')
  })

  it('is a dialog with its title as the accessible name', () => {
    const w = mount(TourCard, { props: cardProps })
    const dialog = w.get('[role="dialog"]')
    const labelledBy = dialog.attributes('aria-labelledby')!
    expect(w.get(`#${labelledBy}`).text()).toBe('Rotate the model')
  })

  it('every control clears the 44px tap-target floor', () => {
    const w = mount(TourCard, { props: cardProps })
    for (const sel of ['[data-tour-next]', '[data-tour-back]', '[data-tour-exit]']) {
      expect(w.get(sel).classes()).toContain('min-h-11')
    }
  })
})

describe('TourCard placement', () => {
  it('right: anchors left of/past the target, never guessing a height', () => {
    const style = withViewport(1024, 768, () => {
      const w = mount(TourCard, { props: { ...cardProps, placement: 'right' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    // main axis: left = target's right edge + GAP (500 + 16)
    expect(style).toContain('left: 516px')
    // cross axis: target's vertical centre (175) is in the top half of a
    // 768-tall viewport, so the card anchors from `top` (= target's top)
    expect(style).toContain('top: 100px')
    expect(style).not.toContain('bottom:')
    expect(style).not.toContain('right:')
  })

  it('left: anchors from the right edge instead of a guessed card width', () => {
    const w = mount(TourCard, { props: { ...cardProps, placement: 'left' } })
    const style = w.get('[data-tour-card]').attributes('style')!
    expect(style).toContain('top:')
    expect(style).toContain('right:')
    expect(style).not.toContain('left:')
  })

  it('bottom: anchors from the top edge, below the target', () => {
    const style = withViewport(1024, 768, () => {
      const w = mount(TourCard, { props: { ...cardProps, placement: 'bottom' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    // main axis: top = target's bottom edge + GAP (250 + 16)
    expect(style).toContain('top: 266px')
    // cross axis: target's horizontal centre (350) is in the left half of a
    // 1024-wide viewport, so the card anchors from `left` (= target's left)
    expect(style).toContain('left: 200px')
    expect(style).not.toContain('bottom:')
  })

  it('top: anchors from the bottom edge so the card never covers its target', () => {
    const w = mount(TourCard, { props: { ...cardProps, placement: 'top' } })
    const style = w.get('[data-tour-card]').attributes('style')!
    expect(style).toContain('bottom:')
    expect(style).toContain('left:')
    expect(style).not.toContain('top:')
  })

  it('center: centres via a transform', () => {
    const w = mount(TourCard, { props: { ...cardProps, placement: 'center' } })
    const style = w.get('[data-tour-card]').attributes('style')!
    expect(style).toContain('transform:')
  })

  it('null rect: centres regardless of the requested placement', () => {
    const w = mount(TourCard, { props: { ...cardProps, rect: null, placement: 'right' } })
    const style = w.get('[data-tour-card]').attributes('style')!
    expect(style).toContain('transform:')
  })
})

describe('TourCard cross-axis anchoring', () => {
  // 1000x800 viewport throughout, so "near the right/bottom edge" and
  // "near the left/top edge" are unambiguous relative to the midpoint.
  const rightEdgeRect = { top: 50, left: 900, width: 80, height: 50, right: 980, bottom: 100 } as DOMRect
  const leftEdgeRect = { top: 50, left: 20, width: 80, height: 50, right: 100, bottom: 100 } as DOMRect
  const bottomEdgeRect = { top: 700, left: 50, width: 50, height: 60, right: 100, bottom: 760 } as DOMRect
  const topEdgeRect = { top: 20, left: 50, width: 50, height: 60, right: 100, bottom: 80 } as DOMRect

  it("bottom: a target near the viewport's right edge anchors the card from `right`, not `left`", () => {
    const style = withViewport(1000, 800, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: rightEdgeRect, placement: 'bottom' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    expect(style).toContain('right:')
    expect(style).not.toContain('left:')
  })

  it("bottom: a target near the viewport's left edge anchors the card from `left`, not `right`", () => {
    const style = withViewport(1000, 800, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: leftEdgeRect, placement: 'bottom' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    expect(style).toContain('left:')
    expect(style).not.toContain('right:')
  })

  it("right: a target near the viewport's bottom edge anchors the card from `bottom`, not `top`", () => {
    const style = withViewport(1000, 800, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: bottomEdgeRect, placement: 'right' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    expect(style).toContain('bottom:')
    expect(style).not.toContain('top:')
  })

  it("right: a target near the viewport's top edge anchors the card from `top`, not `bottom`", () => {
    const style = withViewport(1000, 800, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: topEdgeRect, placement: 'right' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    expect(style).toContain('top:')
    expect(style).not.toContain('bottom:')
  })
})

describe('TourCard clears the chapter rail', () => {
  // Fix round 1: TourRail is `fixed bottom-6` (~60px tall). A card anchored
  // from the bottom used to sit at GAP (16px) above the viewport edge,
  // which the rail's z-50 footprint then covered -- eating the card's own
  // Next button. Any bottom-anchored card must clear the rail instead.
  it("a target near the viewport's bottom edge (placement 'right') anchors well clear of the rail, not at the bare 16px gap", () => {
    // 5px from the bottom edge: with only GAP this would clamp to 16px,
    // which is exactly what the rail's footprint covers.
    const nearBottomRect = { top: 760, left: 50, width: 50, height: 35, right: 100, bottom: 795 } as DOMRect
    const style = withViewport(1000, 800, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: nearBottomRect, placement: 'right' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    const match = style.match(/bottom: (\d+)px/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(96)
  })
})

describe('TourCard stays inside the viewport', () => {
  // Fix round 1 (Task 9): chapter 2's `panels-wide` step targets
  // `[data-tour="panels"]`, a rect spanning nearly the full viewport
  // height. With `placement: 'bottom'`, the old main-axis anchor
  // (`top: r.bottom + GAP`, no cap) landed at or past the viewport's
  // bottom edge -- a real reader on a real desktop could not reach the
  // card's own Next button. This must fail if the clamp in TourCard.vue
  // is removed.
  it("a nearly-full-height target with placement 'bottom' does not push the card's top at or beyond the viewport height", () => {
    // Unclamped, `top = r.bottom + GAP` = 990 + 16 = 1006 -- past the
    // 1000px viewport outright, not merely inside the rail's footprint.
    const nearlyFullHeightRect = { top: 20, left: 100, width: 800, height: 970, right: 900, bottom: 990 } as DOMRect
    const style = withViewport(1024, 1000, () => {
      const w = mount(TourCard, { props: { ...cardProps, rect: nearlyFullHeightRect, placement: 'bottom' } })
      return w.get('[data-tour-card]').attributes('style')!
    })
    const match = style.match(/top: (-?\d+)px/)
    expect(match, `expected a top anchor in "${style}"`).not.toBeNull()
    const top = Number(match![1])
    expect(top).toBeLessThan(1000)
    // Clamped clear of the chapter rail too, not merely inside the box.
    expect(top).toBeLessThanOrEqual(1000 - 96)
  })
})

describe('TourRail', () => {
  const railProps = {
    chapters: TOUR_CHAPTERS, activeChapter: 'interacting' as const,
    stepIndex: 7, stepCount: 14, atEnd: false, playing: true,
  }

  it('renders one segment per chapter and marks the active one', () => {
    const w = mount(TourRail, { props: railProps })
    const segs = w.findAll('[data-tour-chapter]')
    expect(segs).toHaveLength(TOUR_CHAPTERS.length)
    const active = segs.find(s => s.attributes('data-tour-chapter') === 'interacting')!
    expect(active.attributes('aria-current')).toBe('step')
  })

  it('emits the chapter id when a segment is chosen', async () => {
    const w = mount(TourRail, { props: railProps })
    await w.findAll('[data-tour-chapter]')[0]!.trigger('click')
    expect(w.emitted('chapter')![0]).toEqual(['layout'])
  })

  it('the chapter segment button clears the 44px tap-target floor', () => {
    const w = mount(TourRail, { props: railProps })
    const first = w.findAll('[data-tour-chapter]')[0]!
    expect(first.classes()).toContain('min-h-11')
  })

  it('announces position as a live region for screen readers', () => {
    const w = mount(TourRail, { props: railProps })
    const status = w.get('[role="status"]')
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toContain('8')
    expect(status.text()).toContain('14')
  })

  it('the play/pause control emits toggle-playing and labels itself from the playing prop', async () => {
    const w = mount(TourRail, { props: { ...railProps, playing: true } })
    const playButton = w.get('[data-tour-play]')
    expect(playButton.attributes('aria-label')).toBe('Pause the guided tour')
    await playButton.trigger('click')
    expect(w.emitted('toggle-playing')).toHaveLength(1)
  })

  it('the play/pause control relabels itself when paused', () => {
    const w = mount(TourRail, { props: { ...railProps, playing: false } })
    expect(w.get('[data-tour-play]').attributes('aria-label')).toBe('Play the guided tour')
  })

  it('the play/pause control clears the 44px tap-target floor', () => {
    const w = mount(TourRail, { props: railProps })
    expect(w.get('[data-tour-play]').classes()).toContain('size-11')
  })
})
