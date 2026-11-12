import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAppVersion } from '../version'

// Vitest runs from resource-frontend/, so this is resource-frontend/package.json.
const PKG = resolve(process.cwd(), 'package.json')

describe('readAppVersion', () => {
  it('returns the version from this app\'s own package.json', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { version: string }
    expect(readAppVersion(PKG)).toBe(pkg.version)
  })

  it('reads a semver-shaped string', () => {
    expect(readAppVersion(PKG)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('throws, naming the file, when the version field is missing', () => {
    const path = join(tmpdir(), `te-uma-no-version-${Date.now()}.json`)
    writeFileSync(path, JSON.stringify({ name: 'web' }), 'utf8')
    expect(() => readAppVersion(path)).toThrow(/version/)
  })
})
