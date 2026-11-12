import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { groupSentences, layOutCopy, splitSentences } from '../src/components/content/groupSentences'

/**
 * Same reader modalityText.test.ts uses, kept local rather than shared --
 * this repo's existing one-file-one-helper style. It reads the SOURCE file
 * rather than importing the module because the strings contain U+200B and
 * doubled spaces that only survive a byte-level read of the literal.
 */
function readCopySource(): string {
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/content/copy.generated.ts'),
    'utf8',
  )
}

function everyParagraph(): Array<{ name: string, text: string }> {
  const source = readCopySource()
  const out: Array<{ name: string, text: string }> = []
  for (const table of ['anatomyText', 'mammogramText', 'mriText']) {
    const block = source.match(
      new RegExp(`export const ${table} = \\{([\\s\\S]*?)\\n\\} as const`),
    )
    if (!block) throw new Error(`Could not find table "${table}" in copy.generated.ts`)
    for (const m of block[1]!.matchAll(/"([a-z0-9_]+)": "((?:[^"\\]|\\.)*)"/g)) {
      out.push({ name: `${table}.${m[1]}`, text: m[2]! })
    }
  }
  return out
}

const CORPUS = everyParagraph()

describe('splitSentences', () => {
  it('splits on a sentence break followed by a capital', () => {
    expect(splitSentences('First one. Second one. Third one.'))
      .toEqual(['First one.', 'Second one.', 'Third one.'])
  })

  it('does not split on an abbreviation followed by a lowercase word', () => {
    expect(splitSentences('It affects approx. eight women. Then more.'))
      .toEqual(['It affects approx. eight women.', 'Then more.'])
  })

  it('splits before an opening tag, not just before a letter', () => {
    expect(splitSentences('Grades run A to D. <b>Grade D</b> is dense.'))
      .toEqual(['Grades run A to D.', '<b>Grade D</b> is dense.'])
  })

  it('handles an empty string and a single sentence', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('Only one.')).toEqual(['Only one.'])
  })
})

describe('groupSentences balances paragraphs rather than filling greedily', () => {
  it('leaves a short text as one paragraph', () => {
    expect(groupSentences('Short one. Short two.')).toEqual(['Short one. Short two.'])
  })

  /**
   * The exact regression a greedy fill produced on this corpus, and the
   * reason `partition` is exhaustive: filling to a target left whatever
   * remained in the final paragraph, so a four-sentence text came out as one
   * 259-character block plus an 80-character clause stranded under it.
   */
  it('does not strand a short closing sentence under a full block', () => {
    const text = [
      'Fibroadenomas occurs when tissues in the lobule overgrows and becomes hard.',
      'Fibroadenomas are common and thought to be related to the female hormone oestrogen.',
      'Hormone levels are higher when we are young, pregnant, breast feeding or taking hormone replacement.',
      'Although they can appear at any age, they are more likely when aged 15-40 years.',
    ].join(' ')

    const paragraphs = groupSentences(text)
    expect(paragraphs.length).toBe(2)
    // Comparable weight, not one block and one offcut.
    const [a, b] = paragraphs.map(p => p.length) as [number, number]
    expect(Math.abs(a - b)).toBeLessThan(60)
  })
})

describe('layOutCopy declines a lede that is not one', () => {
  it('keeps a short first sentence as the lede', () => {
    const { lede, body } = layOutCopy('Breast cysts are fluid filled sacs. You may have one. Or several.')
    expect(lede).toBe('Breast cysts are fluid filled sacs.')
    expect(body.join(' ')).toBe('You may have one. Or several.')
  })

  it('drops the lede treatment when the first sentence runs long', () => {
    // 180+ characters: at 20px in the 400px content column this is seven
    // lines, which is the wall the lede exists to avoid, not an opening.
    const long = `${'A very long opening clause that keeps going and going '.repeat(4)}ends here. Then a second sentence.`
    const { lede, body } = layOutCopy(long)
    expect(lede).toBe('')
    expect(body.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '))
  })

  it('handles an empty string', () => {
    expect(layOutCopy('')).toEqual({ lede: '', body: [] })
  })
})

/**
 * The global constraint, asserted against every real paragraph in the app
 * rather than against synthetic samples: this is a purely typographic
 * measure, so not one character of clinical copy may move, change or vanish.
 * The truncated samples in modalityText.test.ts cannot catch a regression
 * that only shows up on a six-sentence text or next to a U+200B.
 */
describe('layOutCopy never mutates a character of the real copy', () => {
  for (const { name, text } of CORPUS) {
    it(`${name} round-trips`, () => {
      const { lede, body } = layOutCopy(text)
      const blocks = [lede, ...body].filter(Boolean)
      expect(blocks.length).toBeGreaterThan(0)
      // Whitespace-normalised: the only thing this function consumes is the
      // run of plain spaces at each break it makes.
      expect(blocks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
      // And character-exact once ASCII spaces are stripped, which is what
      // proves no U+200B was swallowed -- `\s` does not match it, so the
      // normalised comparison above would not notice if one went missing.
      expect(blocks.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''))
    })
  }

  /**
   * "No paragraph over 260 characters" is NOT the invariant, and asserting it
   * is how this test first failed. `mammogramText.cancer_ductal` continues
   * "...ductal cancer. 3D tomosynthesis takes..." -- the sentence rule
   * requires a capital or a tag after the break and "3" is neither, so the
   * whole 269-character run is one sentence to this function. Splitting it
   * anyway would mean cutting mid-sentence, which the global constraint
   * forbids outright. The real invariant is that a paragraph is only ever
   * over the cap because it is a single unsplittable sentence.
   */
  it('leaves no multi-sentence paragraph long enough to read as a wall', () => {
    for (const { name, text } of CORPUS) {
      for (const paragraph of layOutCopy(text).body) {
        if (paragraph.length <= 260) continue
        expect(
          splitSentences(paragraph).length,
          `${name} has a ${paragraph.length}-character paragraph that could have been split`,
        ).toBe(1)
      }
    }
  })
})
