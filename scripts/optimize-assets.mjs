#!/usr/bin/env node
/**
 * Asset compression pipeline (design doc §9.1).
 *
 *   assets-src/modelView/**  ->  resource-backend/static/modelView/**
 *
 * · *.nrrd  re-encoded raw -> gzip (three's NRRDLoader reads it natively)
 * · *.glb   Draco geometry compression (@gltf-transform/cli)
 * · *.json  copied as-is (view presets, only tens of bytes)
 * · m2d.nrrd, and u2d.nrrd outside benign-cyst, are skipped as placeholder
 *   copies (design doc §3.1)
 *
 * Idempotent, so it is safe to re-run. Each run builds a full copy of the
 * output into a disposable staging directory, marks it complete by renaming
 * it into a second fixed directory only once every file has succeeded, and
 * only then replaces the real output directory (see the comments around the
 * staging/stagingComplete constants and the final swap below) — so a
 * deleted source file, or output from a run predating a placeholder-filter
 * change, can never linger and ship; a run that throws, is Ctrl-C'd, or is
 * killed outright can't leave resource-backend/static/modelView half-populated either,
 * and can't fool the next run into promoting a half-built tree. An NRRD
 * already declaring encoding: gzip or gz is not recompressed (see gzipNrrd
 * in nrrd-gzip.mjs) — repeated successful runs produce identical output.
 *
 * If a compressed NRRD ever fails to load in copper3d, add its path
 * (relative to assets-src/modelView, forward slashes) to the SKIP_GZIP array
 * below and the pipeline will copy the uncompressed original instead.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipNrrd } from './lib/nrrd-gzip.mjs'
import { orientNrrd } from './lib/nrrd-orient.mjs'

// Locate @gltf-transform/cli's bin entry point and run it with node. It is a
// devDependency of resource-frontend/ — the repo's only Node project (yarn) —
// and the root has no package.json, so resolve it from there.
// Not via `npx`: on Windows npx is a .cmd batch script that execFileSync
// cannot launch without a shell (EINVAL), and going through a shell stops the
// array arguments being escaped properly, so a path containing spaces (such
// as this repo's own "ABI apps" directory) gets split into several arguments.
// `node <bin.js>` is platform-independent and runs an ordinary executable
// (node.exe), needing no shell at all.
const gltfTransformBin = join(
  fileURLToPath(new URL('..', import.meta.url)),
  'resource-frontend', 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js',
)

/** Add a path here by hand to skip gzip re-encoding when it fails to load.
 *  Currently empty — all 18 NRRDs verified. */
const SKIP_GZIP = []

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'assets-src', 'modelView')
const out = join(root, 'resource-backend', 'static', 'modelView')
// Both are fixed siblings of `out`, derived from the same constant, never
// from input. `staging` is where a run writes while it's still in progress
// -- its contents are untrusted until the loop finishes. `stagingComplete`
// is where a run's output is renamed to ONLY once the whole loop has
// returned successfully, so its mere existence is the sole signal this
// script trusts as proof of a complete build (see the startup recovery
// check below for why that distinction matters).
const staging = `${out}.staging`
const stagingComplete = `${out}.complete`

/** Design doc §3.1: these are placeholder copies and never ship. */
function isPlaceholder(rel) {
  const p = rel.split(sep).join('/')
  if (p.includes('m2d.nrrd')) return true
  if (p.includes('u2d.nrrd') && !p.startsWith('benign-cyst/')) return true
  if (p.includes('u_view.json') && !p.startsWith('benign-cyst/')) return true
  return false
}

// Recognise an interrupted final swap before touching anything else.
// Completeness is RECORDED (by the rename to stagingComplete right after a
// successful loop, further down) rather than INFERRED from `out` being
// absent. An earlier version of this recovery check treated "`out` absent,
// `staging` present" as proof of a complete, stranded build, reasoning that
// the mid-loop failure handler always deletes `staging` on a thrown error.
// That reasoning has a hole: it only covers a thrown *exception*. A killed
// process (Ctrl-C, SIGKILL, a crash, power loss) never runs that handler,
// so a genuinely half-built `staging` can survive on disk -- and on a
// repo's first-ever run, `out` never existed either, so the old check would
// have promoted a half-built tree and called it complete. `stagingComplete`
// existing is not vulnerable to that: it is only ever created by the rename
// below, which only runs after the compression loop has already returned
// without throwing, so its presence is sound regardless of whether `out`
// currently exists, was ever created, or what killed a previous run.
if (existsSync(stagingComplete)) {
  try {
    rmSync(out, { recursive: true, force: true })
    renameSync(stagingComplete, out)
    console.log(`  recovered  ${stagingComplete} held a complete build stranded by a run that was interrupted during its final swap; promoted it to ${out}`)
  } catch (err) {
    console.error(`\n  RECOVERY FAILED -- ${stagingComplete} holds a complete build from an interrupted run, but promoting it to ${out} failed: ${err.message}\n  Inspect ${stagingComplete} by hand; if it looks complete, rename it to ${out} yourself.`)
    throw err
  }
}

// A `staging` directory found here (as opposed to `stagingComplete` above)
// was left by a run that never finished: either it threw and the mid-loop
// handler below should have deleted it but the process died before that ran
// too, or it was killed outright mid-loop. Either way its contents are
// unknown and possibly partial -- it was never renamed to `stagingComplete`,
// so nothing here guarantees it is whole. Delete it unconditionally,
// regardless of whether `out` exists, and start every run from a clean
// slate. Wiping the live `out` itself up front (an earlier version of this
// script did that) meant a mid-run failure left the catalogue
// partially populated with no sign it was incomplete; building into this
// disposable directory instead means a failed or killed run never touches
// `out` at all.
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const mb = n => (n / 1024 / 1024).toFixed(1)
let srcTotal = 0
let outTotal = 0
let skipped = 0

try {
  for await (const file of glob('**/*.{nrrd,glb,json}', { cwd: src })) {
    const rel = file
    const from = join(src, rel)
    const to = join(staging, rel)

    if (isPlaceholder(rel)) {
      skipped++
      console.log(`  skip  ${rel}  (placeholder copy)`)
      continue
    }

    // Attach the offending path to any failure. A malformed file anywhere in
    // a 43-file run must fail loudly and name itself -- a bare "NRRD header
    // has no encoding field" with no path is useless when it could be any of
    // them.
    try {
      mkdirSync(dirname(to), { recursive: true })
      const before = statSync(from).size
      srcTotal += before

      if (rel.endsWith('.nrrd')) {
        const relPosix = rel.split(sep).join('/')
        if (SKIP_GZIP.includes(relPosix)) {
          writeFileSync(to, orientNrrd(readFileSync(from)))
        } else {
          writeFileSync(to, gzipNrrd(orientNrrd(readFileSync(from))))
        }
      } else if (rel.endsWith('.glb')) {
        // Draco geometry compression. --simplify false: teaching models are
        // not mesh-simplified, so the anatomy's appearance stays unchanged.
        execFileSync(process.execPath, [gltfTransformBin, 'optimize', from, to,
          '--compress', 'draco', '--texture-compress', 'webp', '--simplify', 'false'],
          { stdio: 'inherit' })
      } else {
        cpSync(from, to)
      }

      const after = statSync(to).size
      outTotal += after
      const pct = before ? Math.round((1 - after / before) * 100) : 0
      console.log(`  ok    ${rel}  ${mb(before)}MB -> ${mb(after)}MB  (-${pct}%)`)
    } catch (err) {
      throw new Error(`optimize-assets: failed on "${rel}": ${err.message}`, { cause: err })
    }
  }
} catch (err) {
  // The run did not complete: discard the half-built staging directory so it
  // can never look like a finished build. This does not claim anything
  // about what is (or isn't) in `out` -- under this script's invariants
  // `out` is only ever replaced from a `stagingComplete` that a fully
  // successful loop produced, but the message below stays deliberately
  // literal rather than asserting that guarantee a second time.
  rmSync(staging, { recursive: true, force: true })
  console.error(existsSync(out)
    ? `\n  FAILED -- this run did not touch ${out}; whatever was there before this run started is still there.`
    : `\n  FAILED -- no build exists at ${out} yet (this looks like the first run, or a previous run never completed successfully).`)
  throw err
}

// The loop finished without throwing: mark this build complete by renaming
// it into its own fixed sibling directory before anything else touches
// `out`. This rename is the ONLY thing that creates `stagingComplete`, and
// therefore the only thing the startup recovery check above trusts as
// proof a build is whole -- a plain `staging` directory is never trusted,
// because a kill (rather than a thrown error) can leave one behind that
// looks superficially present but is actually only partly written.
// A marker *file* inside staging would also record completeness, but it
// would then ship inside modelView/ unless deleted post-rename; renaming
// the whole directory avoids that extra step entirely.
try {
  renameSync(staging, stagingComplete)
} catch (err) {
  throw new Error(`optimize-assets: compression finished but the build could not be marked complete (renaming "${staging}" to "${stagingComplete}" failed): ${err.message}. The build itself is not lost -- it is sitting, unmarked, in "${staging}" -- but the next run will not recognise or recover it automatically; promote or delete it by hand.`, { cause: err })
}

// Every file in this run succeeded and the build is marked complete: swap
// it into place. Both directories are on the same filesystem (under
// resource-backend/static/), so this is a cheap, near-atomic rename rather than a
// second multi-hundred-MB copy.
//
// Guarded like the loop above, because on Windows a running `nuxt dev`
// holding the catalogue open, or an antivirus scan, can make either
// call throw EBUSY/EPERM. The two failure points leave the world in very
// different states and must be reported differently:
//   - rmSync(out) throws: `out` was never touched, so whatever was there
//     before this run is still intact and still being served.
//   - rmSync(out) succeeds but renameSync then throws: `out` is now GONE,
//     and the complete new build is sitting, unpromoted, in
//     `stagingComplete`. The startup recovery step above will pick this
//     exact state up and promote it automatically next run, but say so
//     here too, with the manual fix, in case the site needs to be back
//     sooner than "run this script again".
let outRemoved = false
try {
  rmSync(out, { recursive: true, force: true })
  outRemoved = true
  renameSync(stagingComplete, out)
} catch (err) {
  if (!outRemoved) {
    console.error(`\n  FAILED -- could not remove ${out} to swap in the new build: ${err.message}\n  Whatever was there before this run is untouched and still being served.`)
  } else {
    console.error(`\n  FAILED -- ${out} was removed but the new build could not be promoted from ${stagingComplete}: ${err.message}\n  ${out} is currently MISSING. The complete new build is sitting in ${stagingComplete} -- promote it by hand with:\n    mv "${stagingComplete}" "${out}"\n  (or just re-run this script: it detects and recovers this exact state on startup).`)
  }
  throw err
}

console.log(`\n  total  ${mb(srcTotal)}MB -> ${mb(outTotal)}MB`)
console.log(`  skipped ${skipped} placeholder file(s)`)
