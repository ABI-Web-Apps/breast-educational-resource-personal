import type { TourPhase } from '@/stores/tour'
import type { TourStep } from '@/content/tourTypes'

/**
 * The card's body copy for a given step and phase, decided independently of
 * the store and `TourLayer` so it is unit-testable without mounting the
 * tour (same reasoning as `decideTourKeydown`).
 *
 * `bodyFallback` -- the honest manual instructions -- replaces the demo copy
 * whenever the demo is not actually playing: once the stage has failed
 * ('fallback'), and also while it is still being waited on ('waiting', up to
 * the 60s ceiling for a large volume reporting real progress). The demo copy
 * ("this one is stepping through them") is only true while a demo is running.
 */
export function tourStepBody(phase: TourPhase, step: Pick<TourStep, 'body' | 'bodyFallback'> | undefined): string {
  if (!step) return ''
  return (phase === 'fallback' || phase === 'waiting') && step.bodyFallback
    ? step.bodyFallback
    : step.body
}
