import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every utility class in a template carries the `tw:` prefix (tokens.css
 * explains why: unprefixed, the portal's own `!important` utility classes of
 * the same names land on this app's markup). A class without it is not a
 * style that looks slightly off -- Tailwind generates nothing for it at all.
 *
 * The rest of the suite reads classes WITHOUT the prefix (test/setup.ts), so
 * this is the one place that checks the prefix is there.
 */
const SRC = resolve(__dirname, '../src')

/** Classes that are not Tailwind utilities, and files whose classes aren't. */
const NOT_UTILITIES = new Set(['hud-glass', 'ber-root'])
const OWN_CSS_FILES = new Set(['pages/NotFoundPage.vue'])

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return name.endsWith('.vue') ? [path] : []
  })
}

describe('class prefix', () => {
  const files = vueFiles(SRC).filter(f => !OWN_CSS_FILES.has(relative(SRC, f).replace(/\\/g, '/')))

  it('finds the templates it is meant to check', () => {
    expect(files.length).toBeGreaterThan(15)
  })

  it('prefixes every static utility class', () => {
    const offenders: string[] = []
    for (const file of files) {
      const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
      for (const m of template.matchAll(/\sclass="([^"]*)"/g)) {
        for (const token of m[1]!.split(/\s+/).filter(Boolean)) {
          if (!token.startsWith('tw:') && !NOT_UTILITIES.has(token)) {
            offenders.push(`${relative(SRC, file)}: ${token}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('writes no theme variable by its unprefixed name in an arbitrary value', () => {
    const offenders = files.filter(f => /var\(--(color|text|font|shadow|radius)-/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(f => relative(SRC, f))).toEqual([])
  })
})
