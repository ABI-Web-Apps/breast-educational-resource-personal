import { splitLede } from './splitLede'

/**
 * Decides where the paragraph breaks go in a run of medical copy.
 *
 * The source copy (src/content/copy.generated.ts) is one long string per
 * modality with no paragraph breaks in it at all, so `splitLede` lifting the
 * first sentence still left everything else as a single 4-6 sentence block --
 * eight unbroken lines in the 400px content column. This is the other half of
 * the same purely typographic measure, and it carries the same absolute
 * constraint: it must never change, reorder or drop a single character.
 *
 * The sentence rule is deliberately identical to `splitLede`'s: a period, `!`
 * or `?`, an optional U+200B (which the source copy really does place next to
 * sentence-ending punctuation, and which `\s` does not match), then
 * whitespace, then a capital letter or an opening `<` tag. Missing a break is
 * always preferred over inventing one mid-sentence.
 */

/** Roughly four lines in the content column at its narrowest. */
const TARGET = 190
/** Above this a paragraph is a wall again, whatever its sentence count. */
const MAX = 260
/**
 * Longest first sentence still worth setting as a lede. Past this it is not
 * an introduction, it is the article -- seven lines of 20px type, which is
 * the very thing the lede treatment exists to avoid.
 */
const LEDE_MAX = 170

/** Punctuation, optional ZWSP, then the whitespace before the next sentence.
 *  Capturing group 1 is the part that STAYS with the sentence it ends.
 *  Written as the escape, never as the literal character -- see splitLede.ts
 *  for what an invisible codepoint inside a regex costs a later reader. */
const BREAK = /([.!?]\u200B?)\s+(?=[A-Z<])/g

export function splitSentences(html: string): string[] {
  if (!html) return []

  const out: string[] = []
  let cursor = 0
  for (const m of html.matchAll(BREAK)) {
    const endOfSentence = m.index + m[1]!.length
    out.push(html.slice(cursor, endOfSentence))
    cursor = m.index + m[0].length
  }
  if (cursor < html.length) out.push(html.slice(cursor))
  return out
}

/**
 * The best way to cut `sentences` into exactly `groups` paragraphs.
 *
 * Exhaustive, not greedy, and that is the point: greedy filling to a target
 * length leaves the last paragraph with whatever is left over, which in this
 * corpus was repeatedly a single short clause stranded under a full block.
 * Minimising the squared deviation from an even split instead gives
 * paragraphs of comparable weight, which is what reads as rhythm.
 *
 * A modality paragraph is at most six sentences, so the search is at most a
 * few dozen partitions.
 */
function partition(sentences: string[], groups: number): string[] {
  const n = sentences.length
  if (groups <= 1) return [sentences.join(' ')]
  if (groups >= n) return [...sentences]

  // +1 per join: the single space this function puts between sentences.
  const lengthOf = (from: number, to: number) =>
    sentences.slice(from, to).reduce((sum, s) => sum + s.length, 0) + (to - from - 1)

  const ideal = lengthOf(0, n) / groups
  let best: number[] = []
  let bestCost = Number.POSITIVE_INFINITY

  const cuts: number[] = []
  const search = (start: number, remaining: number) => {
    if (remaining === 0) {
      const bounds = [0, ...cuts, n]
      let cost = 0
      for (let i = 0; i < bounds.length - 1; i++) {
        const delta = lengthOf(bounds[i]!, bounds[i + 1]!) - ideal
        cost += delta * delta
      }
      if (cost < bestCost) {
        bestCost = cost
        best = [...cuts]
      }
      return
    }
    for (let i = start; i <= n - remaining; i++) {
      cuts.push(i)
      search(i + 1, remaining - 1)
      cuts.pop()
    }
  }
  search(1, groups - 1)

  const bounds = [0, ...best, n]
  return Array.from({ length: bounds.length - 1 }, (_, i) =>
    sentences.slice(bounds[i]!, bounds[i + 1]!).join(' '))
}

export function groupSentences(html: string): string[] {
  const sentences = splitSentences(html)
  if (sentences.length === 0) return []

  const total = sentences.reduce((sum, s) => sum + s.length, 0) + sentences.length - 1
  let groups = Math.min(sentences.length, Math.max(1, Math.round(total / TARGET)))

  // Then open it up further if any paragraph is still a wall. One extra
  // paragraph at a time, so a text only ever gets as fragmented as it needs.
  let result = partition(sentences, groups)
  while (groups < sentences.length && result.some(p => p.length > MAX)) {
    groups += 1
    result = partition(sentences, groups)
  }
  return result
}

/**
 * The whole content column's copy, laid out: an optional lede and the body
 * paragraphs under it. One function so the "is this sentence short enough to
 * be a lede" decision lives next to the grouping it changes, rather than
 * being split across a component template.
 */
export function layOutCopy(html: string): { lede: string, body: string[] } {
  if (!html) return { lede: '', body: [] }

  const { lede, rest } = splitLede(html)
  if (lede.length > LEDE_MAX) return { lede: '', body: groupSentences(html) }
  return { lede, body: rest.length ? groupSentences(rest[0]!) : [] }
}
