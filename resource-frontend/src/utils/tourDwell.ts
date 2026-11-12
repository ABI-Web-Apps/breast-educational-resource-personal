/**
 * Auto-advance dwell time for a step's shown body copy, decided
 * independently of the store/TourLayer so it is unit-testable in isolation
 * (same reasoning as `decideTourKeydown`/`tourStepBody`).
 *
 * Roughly 260ms/word on top of a fixed reading-start cost, clamped so a
 * near-empty step still gives a beat and a long one never blocks the tour
 * for too long.
 */
export function tourDwellMs(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean)
  const raw = 2200 + words.length * 260
  return Math.min(12000, Math.max(4000, raw))
}
