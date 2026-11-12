import postcss from 'postcss'
import type { AtRule, Declaration, Plugin, Root, Rule } from 'postcss'
import selectorParser from 'postcss-selector-parser'

/**
 * Makes the plugin build's stylesheet live inside one element.
 *
 * As a plugin this app's CSS is injected into the PORTAL's <head>, next to
 * the portal's own (Vuetify, Element Plus, its global stylesheet). Left as the
 * standalone build emits it, two things go wrong at once:
 *
 *   1. It leaks out. Tailwind's preflight and this app's `body`/`h1`/`*`
 *      rules would restyle the portal.
 *   2. It loses. Tailwind 4 puts everything in cascade layers, and ANY
 *      unlayered rule beats ANY layered one regardless of specificity -- so
 *      the portal's unlayered `* { margin: 0; padding: 0 }` reset would
 *      silently cancel every `tw:p-4`/`tw:mt-6` in the app.
 *
 * So, for the plugin build only (the standalone app is untouched):
 *
 *   - Every selector is scoped under `.ber-root` (PluginRoot.vue's element).
 *     Rules written for `:root`, `:host`, `html` or `body` land on that
 *     element itself; `body[data-tour-active] X` keeps its <body> context
 *     (TourLayer sets that attribute on <body>) and scopes X.
 *   - The layers are flattened, and their ORDER is preserved as specificity
 *     tiers: each tier adds one more `:not(#\#)` -- an ID-weight term that
 *     matches every element -- so a utility still beats any base rule and an
 *     unlayered rule still beats any utility, exactly as the layers ordered
 *     them. Within a tier nothing changes: same selectors, same source order.
 *   - Unlayered, and boosted by at least one ID weight, the scoped rules now
 *     beat the portal's element-level resets on specificity.
 *   - `@keyframes` are renamed (`spin` -> `ber-spin`) so they cannot collide
 *     with a portal animation of the same name.
 *   - A small reset tier (the lowest) puts back the few defaults the portal's
 *     Vuetify reset changes and this app never sets itself: the root starts
 *     from initial values, buttons keep the default cursor, backgrounds
 *     repeat.
 *
 * The other half of the isolation is the `tw:` class prefix (tokens.css):
 * the portal's own `!important` utility classes cannot match this app's
 * markup because no class name is shared.
 */

export interface ScopeOptions {
  /** The root element's class, without the dot. */
  rootClass: string
  /** The stylesheet that receives the reset tier (the Tailwind entry). */
  isMainStylesheet: (file: string | undefined) => boolean
}

type Tier = 'reset' | 'theme' | 'base' | 'components' | 'utilities' | 'unlayered'

/** ID-weight terms per tier. Tailwind's layer order, low to high. */
const TIER_BOOST: Record<Tier, number> = {
  reset: 1,
  theme: 2,
  base: 2,
  components: 3,
  utilities: 4,
  unlayered: 5,
}

const LAYER_TIER: Record<string, Tier> = {
  properties: 'theme',
  theme: 'theme',
  base: 'base',
  components: 'components',
  utilities: 'utilities',
}

const DOCUMENT_TAGS = new Set(['html', 'body'])
const DOCUMENT_PSEUDOS = new Set([':root', ':host'])

export function rootCompound(rootClass: string, tier: Tier): string {
  return `.${rootClass}${':not(#\\#)'.repeat(TIER_BOOST[tier])}`
}

function ancestors(rule: Rule): Array<Root | AtRule | Rule> {
  const found: Array<Root | AtRule | Rule> = []
  for (let node = rule.parent as Root | AtRule | Rule | undefined; node; node = node.parent as typeof node) {
    found.push(node)
  }
  return found
}

function tierOf(rule: Rule): Tier {
  for (const node of ancestors(rule)) {
    if (node.type === 'atrule' && node.name === 'layer') {
      const name = node.params.trim()
      const tier = LAYER_TIER[name]
      if (!tier) throw new Error(`postcss-scope: unknown cascade layer "${name}"`)
      return tier
    }
  }
  return 'unlayered'
}

function insideKeyframes(rule: Rule): boolean {
  return ancestors(rule).some(node => node.type === 'atrule' && /keyframes$/i.test(node.name))
}

/** True when `node` is a pseudo-ELEMENT (`::x`), not a pseudo-class. */
function isPseudoElement(node: selectorParser.Node): boolean {
  return node.type === 'pseudo' && node.value.startsWith('::')
}

export function scopeSelector(selector: string, root: string): string {
  const out: string[] = []
  selectorParser((list) => {
    list.each((sel) => {
      let hasId = false
      sel.walkIds(() => { hasId = true })
      if (hasId) {
        throw new Error(`postcss-scope: an ID selector would break the specificity tiers: "${sel.toString()}"`)
      }
      const nodes = sel.nodes
      const firstCombinator = nodes.findIndex(n => n.type === 'combinator')
      const first = firstCombinator === -1 ? nodes : nodes.slice(0, firstCombinator)
      const rest = firstCombinator === -1 ? '' : nodes.slice(firstCombinator).join('')
      const firstText = first.join('').trim()

      const isDocument = first.some(n =>
        (n.type === 'tag' && DOCUMENT_TAGS.has(n.value.toLowerCase()))
        || (n.type === 'pseudo' && DOCUMENT_PSEUDOS.has(n.value.toLowerCase())))

      if (isDocument) {
        if (first.length === 1) {
          // `:root { }`, `html X` -> the root element itself.
          out.push(`${root}${rest}`)
        }
        else {
          // `body[data-tour-active] X` -> keep the <body> context.
          out.push(`${firstText} ${root}${rest}`)
        }
        return
      }

      const text = sel.toString().trim()
      if (first[0] && isPseudoElement(first[0])) {
        // `::-webkit-scrollbar` styled the document's own scrollbar too; the
        // root element is the plugin's document scroller.
        out.push(`${root}${text}`, `${root} ${text}`)
        return
      }
      out.push(`${root} ${text}`)
    })
  }).processSync(selector)
  return out.join(',\n')
}

function layersIn(css: Root): AtRule[] {
  const found: AtRule[] = []
  css.walkAtRules('layer', (at) => { found.push(at) })
  return found
}

function renameKeyframes(css: Root) {
  const names = new Map<string, string>()
  css.walkAtRules(/keyframes$/i, (at) => {
    const name = at.params.trim()
    const renamed = `ber-${name}`
    names.set(name, renamed)
    at.params = renamed
  })
  if (!names.size) return
  const escaped = [...names.keys()].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![-\\w])(${escaped.join('|')})(?![-\\w])`, 'g')
  css.walkDecls((decl: Declaration) => {
    if (!/^(animation|animation-name|--.*)$/i.test(decl.prop)) return
    decl.value = decl.value.replace(pattern, m => names.get(m) ?? m)
  })
}

function resetRules(rootClass: string): string {
  const r = rootCompound(rootClass, 'reset')
  return `
${r} {
  all: initial;
  /* \`all\` also resets the language Chromium derives from <html lang>,
     which locale-sensitive text (\`uppercase\`, hyphenation) reads. Keep
     the document's, as the standalone app has it. */
  -webkit-locale: inherit;
  display: block;
  height: 100dvh;
  overflow: auto;
  background-color: Canvas;
}
${r} *, ${r} ::before, ${r} ::after, ${r} ::backdrop {
  background-repeat: repeat;
}
${r} ::before, ${r} ::after {
  text-decoration: none;
  vertical-align: baseline;
}
${r} button, ${r} [type=button], ${r} [type=reset], ${r} [type=submit], ${r} [role=button] {
  cursor: default;
}
`
}

export function scopeToRoot(options: ScopeOptions): Plugin {
  return {
    postcssPlugin: 'postcss-scope-to-root',
    OnceExit(css) {
      const file = css.source?.input.file

      css.walkRules((rule) => {
        if (insideKeyframes(rule)) return
        // Nested rules (`& b`) are scoped through their parent.
        if (rule.parent?.type === 'rule') return
        rule.selector = scopeSelector(rule.selector, rootCompound(options.rootClass, tierOf(rule)))
      })

      // Flatten the layers in place, keeping document order. Repeated until
      // none are left, so a layer nested in another is unwrapped too.
      for (let layers = layersIn(css); layers.length; layers = layersIn(css)) {
        for (const at of layers) {
          if (!at.parent) continue
          if (at.nodes?.length) at.replaceWith(at.nodes)
          else at.remove()
        }
      }

      renameKeyframes(css)

      if (options.isMainStylesheet(file)) {
        css.prepend(postcss.parse(resetRules(options.rootClass)).nodes)
      }
    },
  }
}
