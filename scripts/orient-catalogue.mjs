#!/usr/bin/env node
/**
 * Add the missing `space` geometry to every NRRD in the served catalogue,
 * in place. Files that already declare a space are left alone.
 *
 *   node scripts/orient-catalogue.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { orientNrrd } from './lib/nrrd-orient.mjs'

const dryRun = process.argv.includes('--dry-run')
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'resource-backend', 'static', 'modelView')

const files = []
for await (const rel of glob('**/*.nrrd', { cwd: dir })) files.push(rel)
files.sort()

let changed = 0
for (const rel of files) {
  const path = join(dir, rel)
  try {
    const before = readFileSync(path)
    const after = orientNrrd(before)
    if (after === before) continue
    changed++
    if (!dryRun) writeFileSync(path, after)
    console.log(`  ${dryRun ? 'would orient' : 'oriented'}  ${rel.replaceAll(sep, '/')}`)
  } catch (err) {
    throw new Error(`orient-catalogue: failed on "${rel}": ${err.message}`, { cause: err })
  }
}
console.log(`\n  ${changed} file(s) ${dryRun ? 'would change' : 'changed'}`)
