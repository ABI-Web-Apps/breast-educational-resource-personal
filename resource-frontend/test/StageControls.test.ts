import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import StageControls from '../src/components/stage/StageControls.vue'

/**
 * The control bar is deliberately presentational (see useStageControls.ts),
 * so everything that decides what it shows is testable here with no
 * renderer: which controls appear for which case, which of the two slice
 * readouts a screen reader is allowed to hear (controller correction C11),
 * and what the buttons do before the stage exists.
 *
 * Not covered here, and listed for the human browser pass: that
 * `requestFullscreen` on the stage column actually produces a usable
 * fullscreen layout. happy-dom has no Fullscreen API to exercise.
 */

function mountBar(props: Partial<InstanceType<typeof StageControls>['$props']> = {}) {
  return mount(StageControls, {
    props: {
      sliceIndex: 0,
      sliceMax: 0,
      settledSliceIndex: 0,
      lesionSliceIndex: 0,
      ready: true,
      ...props,
    },
  })
}

function buttonNamed(wrapper: ReturnType<typeof mountBar>, label: string) {
  return wrapper.findAll('button').find(b => b.text().includes(label))
}

describe('StageControls', () => {
  it('always offers reset and fullscreen', () => {
    const wrapper = mountBar()
    expect(buttonNamed(wrapper, 'Reset view')).toBeTruthy()
    expect(buttonNamed(wrapper, 'Fullscreen')).toBeTruthy()
  })

  // Design doc §7.2: only the five cases with a lesion get the locator.
  // content/cases.ts gives every other case `lesionSliceIndex` 0 or absent.
  it('shows the lesion locator only for a case that has a lesion AND slices to move through', () => {
    expect(buttonNamed(mountBar({ lesionSliceIndex: 90, sliceMax: 104 }), 'Locate lesion')).toBeTruthy()
    expect(buttonNamed(mountBar({ lesionSliceIndex: 0, sliceMax: 104 }), 'Locate lesion')).toBeUndefined()
    // Anatomy and the 2D ultrasound have no slice stack to glide through,
    // so there is nothing for the locator to do even on a lesion case.
    expect(buttonNamed(mountBar({ lesionSliceIndex: 58, sliceMax: 0 }), 'Locate lesion')).toBeUndefined()
  })

  it('shows the slice readout only when the modality has slices', () => {
    expect(mountBar({ sliceMax: 0 }).text()).not.toContain('Slice')
    expect(mountBar({ sliceIndex: 62, sliceMax: 104 }).text()).toContain('Slice 62 / 104')
  })

  /**
   * Controller correction C11. Two nodes, one number: the visible one
   * changes every frame of an eased scrub and is hidden from assistive
   * tech; the live region carries the settled value only. Getting this
   * backwards makes the app unusable with a screen reader on.
   */
  it('announces the settled slice, not the one changing every frame', () => {
    const wrapper = mountBar({ sliceIndex: 71, settledSliceIndex: 62, sliceMax: 104 })

    const visible = wrapper.find('p[aria-hidden="true"]')
    expect(visible.text()).toBe('Slice 71 / 104')

    const live = wrapper.find('[aria-live="polite"]')
    expect(live.text()).toBe('Slice 62 of 104')
    expect(live.classes()).toContain('sr-only')
  })

  it('uses tabular figures so the readout does not jitter as digits change (§7.5)', () => {
    const wrapper = mountBar({ sliceIndex: 9, sliceMax: 104 })
    expect(wrapper.find('p[aria-hidden="true"]').classes()).toContain('tabular-nums')
  })

  it('emits reset and locate rather than reaching for the stage itself', async () => {
    const wrapper = mountBar({ lesionSliceIndex: 90, sliceMax: 104 })

    await buttonNamed(wrapper, 'Reset view')!.trigger('click')
    await buttonNamed(wrapper, 'Locate lesion')!.trigger('click')

    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(wrapper.emitted('locate')).toHaveLength(1)
  })

  // `CopperStage` is client-only and publishes its actions on mount, so
  // there is a real window (SSR, and while copper3d's chunk downloads) where
  // the buttons would do nothing. Saying so beats silently no-opping.
  it('disables the stage-driven controls until the stage has published its actions', () => {
    const wrapper = mountBar({ ready: false, lesionSliceIndex: 90, sliceMax: 104 })

    expect(buttonNamed(wrapper, 'Reset view')!.attributes('disabled')).toBeDefined()
    expect(buttonNamed(wrapper, 'Locate lesion')!.attributes('disabled')).toBeDefined()
    // Fullscreen is pure DOM and works with or without a renderer.
    expect(buttonNamed(wrapper, 'Fullscreen')!.attributes('disabled')).toBeUndefined()
  })

  it('meets the 44px touch-target floor on every control (§11)', () => {
    const wrapper = mountBar({ lesionSliceIndex: 90, sliceMax: 104 })
    for (const button of wrapper.findAll('button')) {
      expect(button.classes()).toContain('min-h-11')
    }
  })

  it('reports its own fullscreen state, so the button is not a one-way door', async () => {
    const wrapper = mountBar()
    const button = buttonNamed(wrapper, 'Fullscreen')!
    expect(button.attributes('aria-pressed')).toBe('false')

    // happy-dom does not implement `document.fullscreenElement` at all; the
    // component reads the state back off the document rather than assuming
    // its own request succeeded, so defining the property is enough to
    // exercise that path.
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => document.body,
    })
    try {
      document.dispatchEvent(new Event('fullscreenchange'))
      await wrapper.vm.$nextTick()
      expect(buttonNamed(wrapper, 'Exit fullscreen')!.attributes('aria-pressed')).toBe('true')
    }
    finally {
      Reflect.deleteProperty(document, 'fullscreenElement')
    }
  })

  it('has one appearance, not a per-modality palette', () => {
    // §5.3's dark reading-lightbox variant is gone: every modality sits on
    // the same background now, so the bar does too. This pins the absence,
    // because a half-reverted `film` prop would otherwise be invisible.
    expect(mountBar().classes()).toContain('bg-surface')
  })

  it('fullscreens the panel it belongs to, not the whole column', async () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-stage-panel', '')
    const column = document.createElement('div')
    column.setAttribute('data-stage-column', '')
    column.appendChild(panel)
    document.body.appendChild(column)

    const requestFullscreen = vi.fn(() => Promise.resolve())
    panel.requestFullscreen = requestFullscreen as never
    column.requestFullscreen = vi.fn(() => Promise.resolve()) as never

    const wrapper = mount(StageControls, {
      props: {
        sliceIndex: 0, sliceMax: 0, settledSliceIndex: 0, lesionSliceIndex: 0, ready: true,
      },
      attachTo: panel,
    })
    await wrapper.get('button[aria-pressed]').trigger('click')
    expect(requestFullscreen).toHaveBeenCalled()
    expect(column.requestFullscreen).not.toHaveBeenCalled()

    column.remove()
  })

  /**
   * Compact mode replaces each button's inline label with a tooltip, so the
   * text is still in the DOM -- it is just positioned out of flow and held
   * at zero opacity until hover or keyboard focus. Asserting on `text()`
   * therefore cannot tell the two modes apart; the visible difference is
   * that the label is no longer an inline sibling of the icon.
   *
   * The browser's own `title` bubble was used for this first and rejected:
   * unstyled, delayed, and nothing like the rest of the interface.
   */
  it('compact mode moves the button labels into a tooltip, keeping their accessible names', () => {
    const wrapper = mount(StageControls, {
      props: {
        sliceIndex: 3, sliceMax: 10, settledSliceIndex: 3, lesionSliceIndex: 0,
        ready: true, compact: true,
      },
    })
    const reset = wrapper.get('button[aria-label="Reset view"]')

    // The label is present, but as the tooltip: hidden until hover/focus,
    // out of flow, and never able to swallow the click it describes.
    const tip = reset.get('span')
    expect(tip.text()).toBe('Reset view')
    expect(tip.classes()).toContain('opacity-0')
    expect(tip.classes()).toContain('group-hover:opacity-100')
    expect(tip.classes()).toContain('group-focus-visible:opacity-100')
    expect(tip.classes()).toContain('pointer-events-none')
    expect(tip.classes()).toContain('absolute')
    // Not announced twice: the button already carries the same string as
    // its accessible name.
    expect(tip.attributes('aria-hidden')).toBe('true')
    // The hover target has to be the button itself.
    expect(reset.classes()).toContain('group')
    expect(reset.classes()).toContain('relative')

    expect(wrapper.text()).toContain('3 / 10')
  })

  it('full-width mode keeps the label inline and renders no tooltip', () => {
    const wrapper = mount(StageControls, {
      props: {
        sliceIndex: 3, sliceMax: 10, settledSliceIndex: 3, lesionSliceIndex: 0,
        ready: true,
      },
    })
    const label = wrapper.get('button[aria-label="Reset view"]').get('span')
    expect(label.text()).toBe('Reset view')
    expect(label.classes()).not.toContain('absolute')
  })

  it('uses no native title attribute anywhere', () => {
    // `title` renders the browser's own bubble, which is unstyled and
    // delayed. Every hint here is the app's own.
    const wrapper = mount(StageControls, {
      props: {
        sliceIndex: 3, sliceMax: 10, settledSliceIndex: 90, lesionSliceIndex: 90,
        ready: true, compact: true,
      },
    })
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('title')).toBeUndefined()
    }
  })
})
