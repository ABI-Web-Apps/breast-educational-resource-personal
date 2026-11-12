/**
 * Splits a paragraph of medical copy into a "lede" (first sentence) and the
 * "rest" (remaining sentences), so the caller can style the lede as an
 * enlarged introduction (design doc §6.1: a purely typographic measure --
 * it must never change, reorder, or drop a single character).
 *
 * The sentence break is deliberately conservative: it only splits on a
 * period/!/? that is followed by whitespace and then a capital letter (or
 * an opening `<` tag, since some paragraphs continue with `<b>...`). Missing
 * a split (falling back to the whole string as the lede) is preferred over
 * splitting somewhere that changes how the sentence reads.
 *
 * The source copy (src/content/copy.generated.ts) contains literal U+200B
 * zero-width spaces immediately next to sentence-ending punctuation, e.g.
 * "grades, A - D.\u200B Low density...". U+200B is not matched by \s in
 * JavaScript regexes (it is a formatting character, not whitespace), so a
 * naive `[.!?]\s+` immediately after the punctuation fails to match right
 * there and silently swallows one or two extra sentences into the lede
 * before it finds the next real break. The `\u200B?` after the punctuation
 * class absorbs that character (keeping it in the lede, never dropping it)
 * so the split still lands on the first sentence.
 */
export function splitLede(html: string): { lede: string, rest: string[] } {
  if (!html) return { lede: '', rest: [] }

  // Written as the \u200B escape, not the literal invisible character, on
  // purpose: a literal ZWSP here is visually indistinguishable from
  // `[.!?]?` in most editors and diff views. A formatter or lint rule that
  // strips zero-width characters would silently reintroduce the bug this
  // fixes, and the diff would look like a no-op.
  const match = html.match(/^(.*?[.!?]\u200B?)\s+(?=[A-Z<])/s)
  if (!match) return { lede: html, rest: [] }

  const lede = match[1]!
  const rest = html.slice(match[0].length)
  return { lede, rest: rest ? [rest] : [] }
}
