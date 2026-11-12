/**
 * Compares two directories of catalogue snapshots.
 *
 *   node scripts/compare-snapshots.mjs <dirA> <dirB> [--threshold 0.01] [--allow <glob>]...
 *
 * Prints `name  diffRatio` for every pair. The ratio is the share of pixels
 * whose largest channel delta exceeds 16. Exits 1 when an image is missing on
 * one side, when sizes differ, or when a ratio exceeds the threshold -- except
 * for names matching an `--allow` glob (`*` matches any run of characters).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// pngjs is a devDependency of resource-frontend/, not visible from scripts/.
const { PNG } = await import(
  pathToFileURL(join(repoRoot, 'resource-frontend', 'node_modules', 'pngjs', 'lib', 'png.js')).href
)

const CHANNEL_DELTA = 16

const args = process.argv.slice(2)
const dirs = []
const allow = []
let threshold = 0.01
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--threshold') threshold = Number(args[++i])
  else if (args[i] === '--allow') allow.push(args[++i])
  else dirs.push(args[i])
}
if (dirs.length !== 2 || !Number.isFinite(threshold)) {
  console.error('usage: compare-snapshots.mjs <dirA> <dirB> [--threshold 0.01] [--allow <glob>]...')
  process.exit(2)
}
const [dirA, dirB] = dirs

const globToRegExp = g =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\?]/g, '\$&').replace(/\*/g, '.*') + '$')
const allowRes = allow.map(globToRegExp)
const isAllowed = name => allowRes.some(r => r.test(name) || r.test(name.replace(/\.png$/, '')))

const list = d => (existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.png')) : [])
const names = [...new Set([...list(dirA), ...list(dirB)])].sort()
if (names.length === 0) {
  console.error('no PNGs found')
  process.exit(1)
}

let failed = false
for (const name of names) {
  const a = join(dirA, name)
  const b = join(dirB, name)
  if (!existsSync(a) || !existsSync(b)) {
    console.log(`${name}  MISSING (${existsSync(a) ? 'B' : 'A'})`)
    failed = true
    continue
  }
  const pa = PNG.sync.read(readFileSync(a))
  const pb = PNG.sync.read(readFileSync(b))
  if (pa.width !== pb.width || pa.height !== pb.height) {
    console.log(`${name}  SIZE MISMATCH ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
    failed = true
    continue
  }
  let diff = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(
      Math.abs(pa.data[i] - pb.data[i]),
      Math.abs(pa.data[i + 1] - pb.data[i + 1]),
      Math.abs(pa.data[i + 2] - pb.data[i + 2]),
      Math.abs(pa.data[i + 3] - pb.data[i + 3]),
    )
    if (d > CHANNEL_DELTA) diff++
  }
  const ratio = diff / (pa.width * pa.height)
  const allowed = isAllowed(name)
  const over = ratio > threshold
  console.log(`${name}  ${ratio.toFixed(6)}${over ? (allowed ? '  (allowed)' : '  OVER THRESHOLD') : ''}`)
  if (over && !allowed) failed = true
}
process.exit(failed ? 1 : 0)
