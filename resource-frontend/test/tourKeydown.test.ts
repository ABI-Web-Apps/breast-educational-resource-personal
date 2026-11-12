import { describe, expect, it } from 'vitest'
import { decideTourKeydown } from '../src/utils/tourKeydown'

/**
 * Fix round 2, finding 1: `CopperStage`'s own arrow-key camera controls call
 * `preventDefault()` (not `stopPropagation()`), so `TourLayer`'s
 * window-level keydown listener still sees the event bubble past it. Without
 * yielding to `defaultPrevented`, a reader who focuses the 3D stage and
 * presses an arrow key both orbits the camera AND silently steps the tour --
 * exactly the keys the `rotate` step's own copy tells them to press.
 *
 * `TourLayer` is `.client` and pulls in `useTourDirector`/`useRoute`, which
 * `test/setup.ts` deliberately does not stub, so mounting it here is
 * impractical. `decideTourKeydown` is the entire decision rule `onKeydown`
 * delegates to (the dispatch that follows -- `store.next()` / `.back()` /
 * `exitTour()` -- is a direct, untestable-in-isolation call per action), so
 * testing it in isolation covers exactly the logic this bug lived in: an
 * arrow key that resolves to `null` here is one `onKeydown` never acts on,
 * i.e. one that cannot change `store.stepIndex`.
 */
describe('decideTourKeydown', () => {
  function arrowRight(defaultPrevented = false) {
    // `cancelable: true` is required -- preventDefault() is a no-op on a
    // non-cancelable event, same as the real DOM.
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })
    if (defaultPrevented) event.preventDefault()
    return event
  }
  function arrowLeft(defaultPrevented = false) {
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true })
    if (defaultPrevented) event.preventDefault()
    return event
  }

  it('a plain ArrowRight advances (the stage did not claim it)', () => {
    expect(decideTourKeydown(arrowRight())).toBe('next')
  })

  it('a plain ArrowLeft goes back', () => {
    expect(decideTourKeydown(arrowLeft())).toBe('back')
  })

  it('an ArrowRight the stage already claimed (preventDefault) does nothing', () => {
    expect(decideTourKeydown(arrowRight(true))).toBeNull()
  })

  it('an ArrowLeft the stage already claimed (preventDefault) does nothing', () => {
    expect(decideTourKeydown(arrowLeft(true))).toBeNull()
  })

  it('Escape exits, even though the stage never claims it', () => {
    expect(decideTourKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe('exit')
  })

  it('an unrelated key does nothing', () => {
    expect(decideTourKeydown(new KeyboardEvent('keydown', { key: 'Tab' }))).toBeNull()
  })
})
