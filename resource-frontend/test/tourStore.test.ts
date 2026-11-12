import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOUR_SEEN_KEY, useTourStore } from '../src/stores/tour'

describe('tour store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('starts inactive and unseen', () => {
    const s = useTourStore()
    expect(s.active).toBe(false)
    expect(s.hasSeen).toBe(false)
  })

  it('start() activates, records the entry route, and marks the tour seen', () => {
    const s = useTourStore()
    s.start('wide', 8, '/density-c/mri')
    expect(s.active).toBe(true)
    expect(s.stepIndex).toBe(0)
    expect(s.entryRoute).toBe('/density-c/mri')
    expect(s.hasSeen).toBe(true)
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe('1')
  })

  it('hasSeen is restored from localStorage', () => {
    localStorage.setItem(TOUR_SEEN_KEY, '1')
    const s = useTourStore()
    s.restoreSeen()
    expect(s.hasSeen).toBe(true)
  })

  it('next() advances and stops at the last step', () => {
    const s = useTourStore()
    s.start('wide', 3, '/')
    s.next(); s.next()
    expect(s.stepIndex).toBe(2)
    s.next()
    expect(s.stepIndex).toBe(2)
    expect(s.atEnd).toBe(true)
  })

  it('back() never goes below zero', () => {
    const s = useTourStore()
    s.start('wide', 3, '/')
    s.back()
    expect(s.stepIndex).toBe(0)
  })

  it('exit() clears active state but keeps hasSeen', () => {
    const s = useTourStore()
    s.start('wide', 3, '/')
    s.exit()
    expect(s.active).toBe(false)
    expect(s.hasSeen).toBe(true)
  })

  it('every state change bumps the run token, so queued demos can be voided', () => {
    const s = useTourStore()
    s.start('wide', 3, '/')
    const t0 = s.runToken
    s.next()
    expect(s.runToken).toBeGreaterThan(t0)
    const t1 = s.runToken
    s.exit()
    expect(s.runToken).toBeGreaterThan(t1)
  })

  it('phase defaults to playing and can be moved to waiting or fallback', () => {
    const s = useTourStore()
    s.start('wide', 3, '/')
    expect(s.phase).toBe('playing')
    s.phase = 'waiting'
    expect(s.phase).toBe('waiting')
  })

  it('a nonexistent localStorage (private mode) does not throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const s = useTourStore()
    expect(() => s.markSeen()).not.toThrow()
    expect(s.hasSeen).toBe(true)
    spy.mockRestore()
  })

  describe('auto-advance playback state', () => {
    it('defaults to playing when prefers-reduced-motion does not match', () => {
      const s = useTourStore()
      expect(s.playing).toBe(true)
    })

    it('defaults to paused under prefers-reduced-motion: reduce', () => {
      const spy = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
      const s = useTourStore()
      expect(s.playing).toBe(false)
      spy.mockRestore()
    })

    it('togglePlaying flips playing both ways', () => {
      const s = useTourStore()
      s.togglePlaying()
      expect(s.playing).toBe(false)
      s.togglePlaying()
      expect(s.playing).toBe(true)
    })

    it('pause() only ever turns playing off, never on', () => {
      const s = useTourStore()
      s.pause()
      expect(s.playing).toBe(false)
      s.pause()
      expect(s.playing).toBe(false)
    })

    it('pause() does not bump runToken -- an in-flight demo must not be invalidated by a mere pause', () => {
      const s = useTourStore()
      s.start('wide', 3, '/')
      const t0 = s.runToken
      s.pause()
      expect(s.runToken).toBe(t0)
    })
  })
})
