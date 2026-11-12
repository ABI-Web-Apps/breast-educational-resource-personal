/**
 * What a tour keydown should do, decided independently of the store and the
 * director so the rule can be unit-tested without mounting `TourLayer`
 * (which pulls in the director and the router).
 *
 * The `defaultPrevented` check is the actual fix (Task 8 fix round 2):
 * `CopperStage`'s own arrow-key camera controls call `preventDefault()` on
 * the keys they handle, but not `stopPropagation()`, so this window-level
 * listener still sees them. Without this check, focusing the 3D stage and
 * pressing an arrow key both orbited the camera AND silently stepped the
 * tour -- exactly the keys the `rotate` step's own copy tells the reader to
 * press.
 */
export type TourKeyAction = 'exit' | 'next' | 'back' | null

export function decideTourKeydown(event: KeyboardEvent): TourKeyAction {
  if (event.defaultPrevented) return null
  if (event.key === 'Escape') return 'exit'
  if (event.key === 'ArrowRight') return 'next'
  if (event.key === 'ArrowLeft') return 'back'
  return null
}
