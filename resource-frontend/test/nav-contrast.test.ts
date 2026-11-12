import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../src/utils/contrast'

/** Tokens.test.ts guards the raw --color-* values in isolation; it can't
 *  catch a component pairing two individually-fine tokens into a
 *  non-compliant combination (e.g. a 14px-body ink that's only compliant at
 *  >=18.66px, paired with a background it was never checked against). This
 *  file guards the actual pairings the nav components use. Re-implements
 *  the same tiny --color-* reader tokens.test.ts uses, kept local rather
 *  than shared, matching this repo's existing one-file-one-helper style. */
function readColorTokens(): Record<string, string> {
  const tokensPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/assets/css/tokens.css',
  )
  const css = readFileSync(tokensPath, 'utf8')
  const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/)
  if (!theme) throw new Error('No @theme block found in tokens.css')

  const out: Record<string, string> = {}
  for (const m of theme[1]!.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out[m[1]!] = m[2]!
  }
  return out
}

const t = readColorTokens()
const AA_BODY = 4.5
const AA_LARGE = 3

describe('CaseSidebar: active link ink on its highlight background (14px body text)', () => {
  it('text-brand-hover on bg-brand-subtle meets AA body (text-brand does not)', () => {
    const used = contrastRatio(t['brand-hover']!, t['brand-subtle']!)
    const rejected = contrastRatio(t.brand!, t['brand-subtle']!)
    expect(used).toBeGreaterThanOrEqual(AA_BODY)
    // §8 asks for the rose itself here, but on its own 8% tint it is
    // 3.38:1 -- so burgundy carries the label and the rose carries the
    // indicator beside it, which needs only 3:1.
    expect(rejected).toBeLessThan(AA_BODY)
  })

  it('the 4px active indicator clears the 3:1 non-text floor on both surfaces it sits on', () => {
    // The indicator is drawn over the row's own rose tint at the left edge
    // and over the panel's white where the row does not reach.
    expect(contrastRatio(t.brand!, t['brand-subtle']!)).toBeGreaterThanOrEqual(AA_LARGE)
    expect(contrastRatio(t.brand!, t.surface!)).toBeGreaterThanOrEqual(AA_LARGE)
  })
})

describe('CaseSidebar: group headings carry the group ink on white (12px caption)', () => {
  for (const group of ['group-anatomy', 'group-benign', 'group-cancer'] as const) {
    it(`text-${group} meets AA body on white`, () => {
      expect(contrastRatio(t[group]!, t.surface!)).toBeGreaterThanOrEqual(AA_BODY)
    })
  }

  it('the three groups are three different colours', () => {
    // Inequality only: telling blue from teal is a hue question and
    // contrastRatio is a luminance ratio (anatomy and benign are within
    // 1.28:1 and still obviously different). This still catches the
    // realistic regression, which is two groups collapsing onto one token.
    const inks = [t['group-anatomy'], t['group-benign'], t['group-cancer']]
    expect(new Set(inks).size).toBe(3)
  })
})

describe('CaseSidebar: group heading ink on white (12px caption text)', () => {
  it('text-text-muted on white meets AA body (text-text-subtle does not, at this size)', () => {
    const used = contrastRatio(t['text-muted']!, t.surface!)
    const rejected = contrastRatio(t['text-subtle']!, t.surface!)
    expect(used).toBeGreaterThanOrEqual(AA_BODY)
    expect(rejected).toBeLessThan(AA_BODY)
  })
})

describe('case page stage placeholder: ink on the sunken stage background (14px body text)', () => {
  it('text-text-muted on bg-surface-sunken meets AA body (text-text-subtle does not)', () => {
    const used = contrastRatio(t['text-muted']!, t['surface-sunken']!)
    const rejected = contrastRatio(t['text-subtle']!, t['surface-sunken']!)
    expect(used).toBeGreaterThanOrEqual(AA_BODY)
    expect(rejected).toBeLessThan(AA_BODY)
  })
})

describe('ModalityStepper: active step number, white text on a solid ink chip (12px bold)', () => {
  // tokens.test.ts already checks each ink against white as *foreground*
  // (ink text on a white page); contrastRatio is symmetric, so the same
  // numbers apply here with white as the *chip's* colour and the ink as its
  // background. Pinned again here, next to the pairing it belongs to, so a
  // reviewer of ModalityStepper.vue doesn't have to go find tokens.test.ts
  // to see why `bg-current` (which resolved to white-on-white, 1.00:1) was
  // wrong and an explicit `bg-*-ink` utility is required instead.
  const inks = ['anatomy-ink', 'mammogram-ink', 'ultrasound-ink', 'mri-ink'] as const
  for (const ink of inks) {
    it(`text-surface on bg-${ink} meets AA body`, () => {
      expect(contrastRatio(t.surface!, t[ink]!)).toBeGreaterThanOrEqual(AA_BODY)
    })
  }
})

describe('ModalityStepper: inactive step ring and connector on white (non-text, 3:1 floor)', () => {
  it('text-muted meets the 3:1 non-text floor (border-strong does not)', () => {
    const used = contrastRatio(t['text-muted']!, t.surface!)
    // default.vue's bottom-sheet handle documents this exact failure
    // (border-strong measures 1.73:1 on white) and the same fix.
    const rejected = contrastRatio(t['border-strong']!, t.surface!)
    expect(used).toBeGreaterThanOrEqual(AA_LARGE)
    expect(rejected).toBeLessThan(AA_LARGE)
  })
})

/**
 * Task 10 controller correction C10: the stage became focusable this task
 * (`tabindex="0"`, alongside the keyboard handlers Task 7 said to wait for),
 * so its focus indicator now has to meet §11's 3:1 non-text floor -- against
 * the stage background. There used to be two of them -- a dark "reading
 * lightbox" for imaging modalities -- and that treatment is gone: every
 * modality now sits on the light background checked below.
 * `--color-brand` is the app's one focus colour (tokens.css's
 * `:focus-visible` rule), so a token change that quietly broke this would
 * otherwise only be visible to someone tabbing onto the canvas.
 */
describe('CopperStage: focus ring on the stage background', () => {
  /**
   * The stage's ring is drawn as an inset double box-shadow: brand, then a
   * 2px `--color-surface` ring just outside it. That second ring is the
   * whole point -- it means the brand ring's contrast does not depend on
   * whatever the model happens to be rendering underneath, which is what an
   * inward `outline` on a canvas could never guarantee.
   */
  it('the stage focus ring clears 3:1 against the surface ring it is drawn on', () => {
    expect(contrastRatio(t.brand!, t.surface!)).toBeGreaterThanOrEqual(AA_LARGE)
  })

  it('the brand focus outline clears 3:1 on the light anatomy background', () => {
    // The stage paints a gradient from surface-sunken to bg; the ring must
    // clear the floor against either end of it.
    expect(contrastRatio(t.brand!, t.bg!)).toBeGreaterThanOrEqual(AA_LARGE)
    expect(contrastRatio(t.brand!, t['surface-sunken']!)).toBeGreaterThanOrEqual(AA_LARGE)
  })
})
