/** A finding with no colour, or one that is not `#rrggbb`, is drawn in this
 *  neutral grey. The backend's mesh rule is the same (`mesh.NEUTRAL_COLOR`). */
export const NEUTRAL_COLOR = '#94a3b8'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * The colour a finding is drawn in, everywhere it shows: its mesh, its legend
 * dot and its name in the colour sentence. Its own `#rrggbb`, or the neutral
 * grey (the findings record's `color` is optional and may be `null`).
 */
export function findingColour(color: string | null | undefined): string {
  return typeof color === 'string' && HEX_COLOR.test(color) ? color : NEUTRAL_COLOR
}
