import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { rootCompound, scopeSelector, scopeToRoot } from '../tooling/postcss-scope'

/**
 * The plugin build's stylesheet transform (tooling/postcss-scope.ts). What it
 * must guarantee: nothing reaches outside `.ber-root`, the cascade between
 * Tailwind's layers keeps its order, and the result carries no layers for
 * the portal's unlayered CSS to beat.
 */
const ROOT = 'ber-root'

function run(css: string, file = '/x/tokens.css') {
  return postcss([scopeToRoot({ rootClass: ROOT, isMainStylesheet: f => Boolean(f?.endsWith('tokens.css')) })])
    .process(css, { from: file }).css
}

describe('scopeSelector', () => {
  const r = rootCompound(ROOT, 'base')

  it('puts an ordinary selector under the root', () => {
    expect(scopeSelector('.tw\\:flex', r)).toBe(`${r} .tw\\:flex`)
    expect(scopeSelector('h1, h2', r)).toBe(`${r} h1,\n${r} h2`)
  })

  it('maps the document onto the root element itself', () => {
    expect(scopeSelector(':root', r)).toBe(r)
    expect(scopeSelector('html, :host', r)).toBe(`${r},\n${r}`)
    expect(scopeSelector('body', r)).toBe(r)
  })

  it('keeps a qualified <body> as context, so TourLayer\'s attribute still works', () => {
    expect(scopeSelector('body[data-tour-active] [data-tour-region]', r))
      .toBe(`body[data-tour-active] ${r} [data-tour-region]`)
  })

  it('styles the root\'s own scrollbar as well as its descendants\'', () => {
    expect(scopeSelector('::-webkit-scrollbar', r)).toBe(`${r}::-webkit-scrollbar,\n${r} ::-webkit-scrollbar`)
  })

  it('refuses an ID selector, which would outrank the tiers', () => {
    expect(() => scopeSelector('#app .x', r)).toThrow(/ID selector/)
  })
})

describe('scopeToRoot', () => {
  it('flattens the layers, keeping their order as tiers', () => {
    const out = run(`
      @layer theme, base, utilities;
      @layer base { * { margin: 0 } }
      @layer utilities { .tw\\:p-4 { padding: 1rem } }
      .loose { color: red }
    `)
    expect(out).not.toContain('@layer')
    const tier = (n: number) => `.${ROOT}${':not(#\\#)'.repeat(n)}`
    expect(out).toContain(`${tier(2)} * {`)
    expect(out).toContain(`${tier(4)} .tw\\:p-4 {`)
    expect(out).toContain(`${tier(5)} .loose {`)
  })

  it('gives every tier strictly more ID weight than the one below it', () => {
    const ids = (tier: Parameters<typeof rootCompound>[1]) => rootCompound(ROOT, tier).split('#').length - 1
    const order = ['reset', 'base', 'components', 'utilities', 'unlayered'] as const
    for (let i = 1; i < order.length; i++) expect(ids(order[i]!)).toBeGreaterThan(ids(order[i - 1]!))
    expect(ids('theme')).toBe(ids('base'))
  })

  it('renames keyframes and every animation that names them', () => {
    const out = run(`
      @keyframes spin { to { transform: rotate(360deg) } }
      @layer theme { :root { --tw-animate-spin: spin 1s linear infinite } }
      .a { animation: spin 1s; animation-name: spin }
    `)
    expect(out).toContain('@keyframes ber-spin')
    expect(out).toContain('--tw-animate-spin: ber-spin 1s linear infinite')
    expect(out).toContain('animation: ber-spin 1s')
    expect(out).toContain('animation-name: ber-spin')
    // A property NAME containing the word is not an animation reference.
    expect(out).not.toContain('--tw-animate-ber-spin')
  })

  it('leaves keyframe steps alone', () => {
    expect(run('@keyframes tour-scan { 0% { top: 0 } 100% { top: 100% } }')).toMatch(/0% \{ top: 0 \}/)
  })

  it('adds the reset tier to the main stylesheet only', () => {
    expect(run('.a { color: red }', '/x/tokens.css')).toContain('all: initial')
    expect(run('.a { color: red }', '/x/Card.vue?vue&type=style')).not.toContain('all: initial')
  })

  it('keeps the document language through the root\'s reset', () => {
    expect(run('.a {}')).toContain('-webkit-locale: inherit')
  })
})
