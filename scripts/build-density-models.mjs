/**
 * Rebuilds all four density anatomy models from density-3's source.
 *
 * The four `density*.glb` models differ in ONE thing: how many mammary lobes
 * the breast contains. Everything else -- fat, areola, nipple, ducts,
 * sinuses, suspensory ligaments -- is identical across all four, and
 * `density75.glb` (density-3) is the model the author actually built. The
 * others were meant to be it with lobes removed or added:
 *
 *     density-1  -50%   density-2  -25%   density-3  baseline   density-4  +100%
 *
 * They had drifted badly from that. Measured on the shipped assets, counting
 * connected lobe islands: density-1 had 4 of 19 (-79%), density-2 had 7
 * (-63%), and density-4 was not thinned or thickened by lobe at all -- it
 * carried THREE whole copies of the lobes mesh at ~1cm offsets, 227,364
 * triangles for what should be roughly half again the baseline.
 *
 * And the source itself carries four fragments that no duct reaches --
 * lobes whose duct was deleted in Blender, left floating unattached inside
 * the fat layer. Those are dropped from every model including density-3,
 * which is why density-3 is rebuilt here too despite its lobe count being
 * unchanged. See ORPHAN_DISTANCE. The real baseline is 15 lobes, not 19.
 *
 * ## Method
 *
 * Lobes are removed and added as WHOLE LOBES, never as loose triangles. A
 * lobe is a connected component of the `VH_F_mammary_lobes_L` primitive,
 * found by union-find over the index buffer after welding vertices by
 * position -- the mesh is exported unwelded, so without the weld every quad
 * looks like its own island (9,325 of them, which is what a first pass
 * reported).
 *
 * Which lobes go is decided deterministically and spatially: islands are
 * ordered by centroid height and picked with an even stride, so thinning
 * empties the breast uniformly instead of hollowing out one end of it.
 * Re-running this script always produces the same models.
 *
 * For density-4, the extra lobes are copies of existing ones nudged toward
 * the lobe cloud's own centroid, so they stay inside the fat layer.
 *
 * ## Running it
 *
 *     node scripts/build-density-models.mjs [--dry-run]
 *
 * Reads the uncompressed original under `assets-src/modelView/` and writes
 * Draco-compressed output to `resource-backend/static/modelView/`, the same arrangement
 * `optimize-assets.mjs` produces. The source is never written.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The repo root has no `node_modules` -- `resource-frontend/` is the only Node project
// here -- so these resolve by path rather than by bare specifier.
const modules = join(root, 'resource-frontend/node_modules').replaceAll('\\', '/')
const { NodeIO } = await import(`file:///${modules}/@gltf-transform/core/dist/index.js`)
const { ALL_EXTENSIONS } = await import(`file:///${modules}/@gltf-transform/extensions/dist/index.js`)
const SOURCE = join(root, 'assets-src/modelView/density-3/left/density75.glb')
const LOBES = 'VH_F_mammary_lobes_L'
const DUCTS = 'VH_F_main_lactiferous_ducts_L'
const FAT = 'VH_F_fat_L'

/**
 * How far the fat-pocket test's box is shrunk about the removed lobe's
 * centre. See its use below for why shrinking rather than a proximity test.
 */


/**
 * How close a lobe's nearest vertex must come to duct geometry to count as
 * a real lobe rather than debris.
 *
 * Read off the source model's own distribution rather than guessed. Measured
 * on density75.glb, the nineteen islands fall into two groups with nothing
 * between them:
 *
 *   15 lobes    3,398-6,802 triangles   0.00003-0.00026 from a duct
 *    4 shards       2-200 triangles     0.00193-0.00793 from a duct
 *
 * Seven times the distance and a seventeenth of the size; both criteria
 * select the same four. Those four are the geometry the human pointed at --
 * lobes whose duct was deleted in Blender and which were left floating
 * unattached. 0.001 sits in the gap.
 */
const ORPHAN_DISTANCE = 0.001

/** Refuse to run if the filter would take an implausible share of the model.
 * A threshold that has drifted out of the gap should stop the build, not
 * quietly halve the anatomy. */
const MAX_ORPHAN_FRACTION = 0.35
const DRY_RUN = process.argv.includes('--dry-run')

/** Output file per target, and the lobe count each should end up with as a
 * fraction of density-3's. */
const TARGETS = [
  { dir: 'density-1', file: 'density25.glb', ratio: 0.5 },
  { dir: 'density-2', file: 'density50.glb', ratio: 0.75 },
  // density-3 is the baseline and its lobe count is unchanged, but it is
  // rebuilt like the others so the orphan shards come out of it too. It
  // shipped with them.
  { dir: 'density-3', file: 'density75.glb', ratio: 1 },
  // BI-RADS D is "extremely dense", and at 1.5 it read no fuller than C on
  // screen -- partly the count, partly that duplicates were landing behind
  // lobes that were already there (see `planDuplicates`).
  { dir: 'density-4', file: 'density100.glb', ratio: 2 },
]

/**
 * How far a duplicated lobe is moved ALONG THE DUCT TREE, as a fraction of
 * its own size.
 *
 * A duplicate is not translated freely. Two earlier versions were, and both
 * were wrong in the same way. The first used 6% of the distance to the lobe
 * cloud's centre -- about a twentieth of a lobe -- so copies landed on top
 * of their originals and added no visible density. The second used half a
 * lobe toward the centre, which was visible and produced exactly the defect
 * the whole orphan filter exists to remove: a lobe hanging in the fat with
 * no duct reaching it. The human found them immediately.
 *
 * A duplicate now slides to a different point on the SAME duct, so it is
 * attached by construction -- two lobes on one duct, which is what a denser
 * breast actually looks like. This is how far along, measured from the
 * original's own contact point.
 */
const DUPLICATE_NUDGE = 0.8

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

/**
 * Splits a primitive into connected components.
 *
 * Welds by quantised position first: these meshes duplicate every shared
 * corner per face, so raw index adjacency says nothing about connectivity.
 * 1e-6 is far below the smallest real feature (the smallest lobe spans
 * ~0.014 model units).
 */
function findIslands(prim) {
  const idx = prim.getIndices().getArray()
  const pos = prim.getAttribute('POSITION').getArray()
  const n = prim.getAttribute('POSITION').getCount()

  const canon = new Int32Array(n)
  const seen = new Map()
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] * 1e6)},${Math.round(pos[i * 3 + 1] * 1e6)},${Math.round(pos[i * 3 + 2] * 1e6)}`
    const hit = seen.get(key)
    if (hit === undefined) { seen.set(key, i); canon[i] = i }
    else canon[i] = hit
  }

  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (let t = 0; t < idx.length; t += 3) {
    union(canon[idx[t]], canon[idx[t + 1]])
    union(canon[idx[t + 1]], canon[idx[t + 2]])
  }

  const groups = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(canon[idx[t]])
    let g = groups.get(r)
    if (!g) {
      g = { tris: [], centroid: [0, 0, 0], count: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      groups.set(r, g)
    }
    g.tris.push(t)
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k] * 3
      for (let a = 0; a < 3; a++) {
        const c = pos[v + a]
        g.centroid[a] += c
        if (c < g.min[a]) g.min[a] = c
        if (c > g.max[a]) g.max[a] = c
      }
      g.count++
    }
  }
  for (const g of groups.values()) {
    g.centroid = g.centroid.map(c => c / g.count)
    /** Longest edge of the lobe's bounding box -- the length scale a
     * duplicate's offset is measured in. */
    g.size = Math.max(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2])
  }
  return [...groups.values()]
}

/** Evenly spaced picks from `total`, always including the first. Used so a
 * thinned breast keeps lobes spread through its whole height. */
function evenPicks(total, keep) {
  if (keep >= total) return [...Array(total).keys()]
  const step = total / keep
  const out = []
  for (let i = 0; i < keep; i++) out.push(Math.min(total - 1, Math.floor(i * step)))
  return [...new Set(out)]
}

/**
 * Rewrites the lobes primitive to contain exactly `keptIslands`, plus
 * `duplicates` extra copies, compacting the vertex buffers so nothing
 * unreferenced survives into the output.
 */
function rewriteLobes(doc, prim, kept, duplicates) {
  const idx = prim.getIndices().getArray()
  const semantics = prim.listSemantics()
  const src = Object.fromEntries(
    semantics.map(s => [s, prim.getAttribute(s).getArray()]),
  )
  const sizes = Object.fromEntries(
    semantics.map(s => [s, prim.getAttribute(s).getElementSize()]),
  )

  const remap = new Map()
  const outVerts = Object.fromEntries(semantics.map(s => [s, []]))
  const outIdx = []

  /** Appends one triangle, translating its vertices by `offset`. A non-zero
   * offset always allocates fresh vertices: a duplicated lobe must not share
   * positions with the original it was copied from. */
  function emit(triStart, offset) {
    for (let k = 0; k < 3; k++) {
      const v = idx[triStart + k]
      const key = offset ? `d${offset.id}:${v}` : `${v}`
      let mapped = remap.get(key)
      if (mapped === undefined) {
        mapped = outVerts.POSITION.length / 3
        for (const s of semantics) {
          const size = sizes[s]
          for (let c = 0; c < size; c++) {
            let value = src[s][v * size + c]
            if (offset && s === 'POSITION') value += offset.delta[c]
            outVerts[s].push(value)
          }
        }
        remap.set(key, mapped)
      }
      outIdx.push(mapped)
    }
  }

  for (const island of kept) for (const t of island.tris) emit(t, null)
  duplicates.forEach((island, i) => {
    for (const t of island.tris) emit(t, { id: i, delta: island.duplicateDelta })
  })

  for (const s of semantics) {
    prim.getAttribute(s).setArray(new Float32Array(outVerts[s]))
  }
  prim.getIndices().setArray(
    outIdx.length > 65535 ? new Uint32Array(outIdx) : new Uint16Array(outIdx),
  )
  return outIdx.length / 3
}

/**
 * A spatial hash over the duct mesh's vertices, with a nearest-point query.
 *
 * Searched shell by shell outward from the query point and stopped as soon
 * as the best hit is closer than the shell being examined, so the common
 * case -- a lobe sitting right on its duct -- costs one bucket lookup.
 */
function ductVertices(doc) {
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(DUCTS))
  const prim = mesh?.listPrimitives()[0]
  if (!prim) throw new Error(`No ${DUCTS} mesh in ${SOURCE}`)
  const pos = prim.getAttribute('POSITION').getArray()
  const count = prim.getAttribute('POSITION').getCount()
  // Every 6th vertex. The duct mesh is dense tubing; the planner only needs
  // somewhere plausible to slide to, and the full set makes its O(n*m) scan
  // needlessly slow.
  const out = []
  for (let i = 0; i < count; i += 6) out.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
  return out
}

function buildDuctIndex(doc) {
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(DUCTS))
  const prim = mesh?.listPrimitives()[0]
  if (!prim) throw new Error(`No ${DUCTS} mesh in ${SOURCE}`)
  const pos = prim.getAttribute('POSITION').getArray()
  const count = prim.getAttribute('POSITION').getCount()

  const CELL = 0.004
  const grid = new Map()
  const key = (a, b, c) => `${a},${b},${c}`
  for (let i = 0; i < count; i++) {
    const k = key(
      Math.floor(pos[i * 3] / CELL),
      Math.floor(pos[i * 3 + 1] / CELL),
      Math.floor(pos[i * 3 + 2] / CELL),
    )
    let bucket = grid.get(k)
    if (!bucket) { bucket = []; grid.set(k, bucket) }
    bucket.push(i)
  }

  return function nearest(x, y, z) {
    const cx = Math.floor(x / CELL)
    const cy = Math.floor(y / CELL)
    const cz = Math.floor(z / CELL)
    let best = Infinity
    for (let r = 0; r <= 25; r++) {
      for (let a = cx - r; a <= cx + r; a++) {
        for (let b = cy - r; b <= cy + r; b++) {
          for (let c = cz - r; c <= cz + r; c++) {
            // Shell only: skip the interior, which earlier rings covered.
            if (r > 0 && Math.abs(a - cx) !== r && Math.abs(b - cy) !== r && Math.abs(c - cz) !== r) continue
            for (const i of grid.get(key(a, b, c)) ?? []) {
              const d = Math.hypot(pos[i * 3] - x, pos[i * 3 + 1] - y, pos[i * 3 + 2] - z)
              if (d < best) best = d
            }
          }
        }
      }
      if (best <= r * CELL) return best
    }
    return best
  }
}

/**
 * Drops lobes that no duct reaches -- the incompletely-deleted geometry:
 * fragments left behind when a lobe's duct was deleted in Blender, which
 * then float unattached inside the fat layer.
 *
 * See ORPHAN_DISTANCE for where the threshold comes from. Throws rather than
 * proceeds if it would take an implausible share of the model.
 */
function dropOrphans(islands, prim, nearestDuct) {
  const idx = prim.getIndices().getArray()
  const pos = prim.getAttribute('POSITION').getArray()

  const attached = []
  const orphans = []
  for (const island of islands) {
    let min = Infinity
    outer: for (const t of island.tris) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k] * 3
        const d = nearestDuct(pos[v], pos[v + 1], pos[v + 2])
        if (d < min) min = d
        if (min <= ORPHAN_DISTANCE) break outer
      }
    }
    ;(min <= ORPHAN_DISTANCE ? attached : orphans).push({ ...island, ductDistance: min })
  }

  if (orphans.length / islands.length > MAX_ORPHAN_FRACTION) {
    throw new Error(
      `Orphan filter would drop ${orphans.length} of ${islands.length} lobes, `
      + `over the ${MAX_ORPHAN_FRACTION * 100}% ceiling. ORPHAN_DISTANCE `
      + `(${ORPHAN_DISTANCE}) no longer sits in this model's distribution.`,
    )
  }
  return { attached, orphans }
}


/**
 * Works out where each duplicated lobe goes.
 *
 * A duplicate slides ALONG the duct tree rather than translating freely
 * through the fat, which is what makes it attached by construction. For each
 * lobe: find where it touches a duct, then find another duct vertex roughly
 * `DUPLICATE_NUDGE` lobe-widths away, and translate by the difference. The
 * copy lands on the same duct at a different height -- two lobes on one
 * duct, which is what a denser breast looks like.
 *
 * Returns only the duplicates it could place. A lobe whose duct has no room
 * further along is skipped rather than dropped somewhere invalid, so the
 * final count can come in under target; the caller reports what it got.
 */
/**
 * The areola/nipple region, as a box, so duplicates are never placed into
 * it. A copy that lands there pokes through the skin and shows as a pale
 * patch on the nipple -- which is exactly what +100% produced on the first
 * build. Taken from the areola mesh's own bounds with a small margin.
 */
function forbiddenZone(doc) {
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith('VH_F_areola_L'))
  const pos = mesh?.listPrimitives()[0]?.getAttribute('POSITION')
  if (!pos) return null
  const min = pos.getMin([])
  const max = pos.getMax([])
  const pad = 0.004
  return {
    min: min.map(v => v - pad),
    max: max.map(v => v + pad),
  }
}

function planDuplicates(candidates, prim, ductPoints, occupied, forbidden) {
  const idx = prim.getIndices().getArray()
  const pos = prim.getAttribute('POSITION').getArray()
  const placed = []
  // Grows as duplicates are placed, so two of them cannot pick the same
  // empty spot.
  const taken = [...occupied]

  for (const island of candidates) {
    // The lobe's own contact point on the duct tree, and the duct point it
    // touches.
    let best = Infinity
    let contact = null
    let anchor = null
    for (const t of island.tris) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k] * 3
        const p = [pos[v], pos[v + 1], pos[v + 2]]
        for (const q of ductPoints) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
          if (d < best) { best = d; contact = p; anchor = q }
        }
      }
    }
    if (!contact || !anchor) continue

    /**
     * Where on the tree to put the copy.
     *
     * Not simply "one lobe further along": the first version took the duct
     * point nearest that distance and, often as not, that was straight into
     * the middle of the cluster, where the copy sat behind a lobe already
     * there and added nothing visible. density-4 came out looking no denser
     * than density-3 despite carrying eight more lobes.
     *
     * So candidates within a band of the anchor are scored by how far they
     * are from every lobe already placed, and the emptiest wins. `taken`
     * grows as copies are placed, so two of them cannot choose the same gap.
     */
    const want = island.size * DUPLICATE_NUDGE
    let target = null
    let bestScore = -Infinity
    for (const q of ductPoints) {
      const d = Math.hypot(q[0] - anchor[0], q[1] - anchor[1], q[2] - anchor[2])
      if (d < want * 0.6 || d > want * 2.5) continue
      if (forbidden
        && q[0] >= forbidden.min[0] && q[0] <= forbidden.max[0]
        && q[1] >= forbidden.min[1] && q[1] <= forbidden.max[1]
        && q[2] >= forbidden.min[2] && q[2] <= forbidden.max[2]) continue
      let nearest = Infinity
      for (const o of taken) {
        const dist = Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2])
        if (dist < nearest) nearest = dist
      }
      if (nearest > bestScore) { bestScore = nearest; target = q }
    }
    if (!target) continue

    const delta = [0, 1, 2].map(a => target[a] - anchor[a])
    taken.push([0, 1, 2].map(a => island.centroid[a] + delta[a]))
    placed.push({ ...island, duplicateDelta: delta })
  }
  return placed
}


/**
 * Rebuilds a primitive keeping only the triangles `keep` accepts, compacting
 * the vertex buffers so nothing unreferenced survives.
 *
 * Shares the compaction with `rewriteLobes`; kept separate because that one
 * also has to emit translated duplicates and this one never does.
 */
function filterTriangles(prim, keep) {
  const idx = prim.getIndices().getArray()
  const semantics = prim.listSemantics()
  const src = Object.fromEntries(semantics.map(s => [s, prim.getAttribute(s).getArray()]))
  const sizes = Object.fromEntries(semantics.map(s => [s, prim.getAttribute(s).getElementSize()]))

  const remap = new Map()
  const outVerts = Object.fromEntries(semantics.map(s => [s, []]))
  const outIdx = []
  let dropped = 0

  for (let t = 0; t < idx.length; t += 3) {
    if (!keep(t)) { dropped++; continue }
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k]
      let mapped = remap.get(v)
      if (mapped === undefined) {
        mapped = outVerts.POSITION.length / 3
        for (const sem of semantics) {
          const size = sizes[sem]
          for (let c = 0; c < size; c++) outVerts[sem].push(src[sem][v * size + c])
        }
        remap.set(v, mapped)
      }
      outIdx.push(mapped)
    }
  }

  for (const sem of semantics) prim.getAttribute(sem).setArray(new Float32Array(outVerts[sem]))
  prim.getIndices().setArray(
    outIdx.length > 65535 ? new Uint32Array(outIdx) : new Uint16Array(outIdx),
  )
  return dropped
}

/**
 * Removes geometry that lived inside lobes which are no longer there.
 *
 * Applied to TWO meshes, and the second is the one that actually mattered.
 *
 * The fat shell is moulded around the lobes: it carries a lobe-shaped pocket
 * at every lobe's position. While the lobe is there the pocket is filled and
 * invisible. Delete the lobe and the empty pocket shows through the
 * translucent shell as a pale, fat-coloured cluster -- which is what the
 * human kept pointing at and calling a yellow lobe. Confirmed by tinting the
 * fat layer green at runtime: those clusters turned green with it while the
 * real lobes stayed pink. Three earlier rounds looked for bad GEOMETRY and
 * found none, because the geometry was fine.
 *
 * The duct mesh gets the same treatment for the same reason: it carries a
 * terminal blob inside each lobe, 255-1711 triangles apiece.
 *
 * Measured on density75: each of the fifteen real lobes hides 255-1711 duct
 * triangles, 11,358 of 34,755 in total. The four debris shards hide none,
 * which is one more piece of evidence that they are not lobes.
 *
 * The test is a triangle's centroid falling inside the removed lobe's own
 * bounding box -- no tuned threshold, and it cannot reach geometry that was
 * not already hidden by that lobe. It does take the last few millimetres of
 * the duct that ran INTO the lobe, which is correct: a duct should not end
 * in mid-air where its lobe used to be.
 */
/**
 * Bounding-box variant, for the DUCT mesh.
 *
 * The duct mesh is all interior tubing -- it has no outer skin to punch a
 * hole in -- so the cheap test is safe there, and it is the right one: what
 * has to go is the terminal blob that filled the removed lobe's volume.
 */
function dropInsideBoxes(doc, removedLobes, meshPrefix, shrink = 1) {
  if (!removedLobes.length) return 0
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(meshPrefix))
  const prim = mesh?.listPrimitives()[0]
  if (!prim) return 0

  const idx = prim.getIndices().getArray()
  const pos = prim.getAttribute('POSITION').getArray()
  const boxes = removedLobes.map((l) => {
    const c = [0, 1, 2].map(a => (l.min[a] + l.max[a]) / 2)
    const h = [0, 1, 2].map(a => ((l.max[a] - l.min[a]) / 2) * shrink)
    return { min: [0, 1, 2].map(a => c[a] - h[a]), max: [0, 1, 2].map(a => c[a] + h[a]) }
  })

  return filterTriangles(prim, (t) => {
    let x = 0; let y = 0; let z = 0
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k] * 3
      x += pos[v]; y += pos[v + 1]; z += pos[v + 2]
    }
    x /= 3; y /= 3; z /= 3
    for (const b of boxes) {
      if (x >= b.min[0] && x <= b.max[0]
        && y >= b.min[1] && y <= b.max[1]
        && z >= b.min[2] && z <= b.max[2]) return false
    }
    return true
  })
}

function dropHiddenGeometry(doc, removedLobes, lobePrim, meshPrefix) {
  if (!removedLobes.length) return 0
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(meshPrefix))
  const prim = mesh?.listPrimitives()[0]
  if (!prim) return 0

  // A spatial hash of the removed lobes' own surface points. Proximity to
  // THAT -- not merely falling inside a bounding box -- is what identifies
  // the pocket. The bounding-box version punched a visible hole through the
  // outer skin, because a lobe near the surface has skin inside its box.
  const lidx = lobePrim.getIndices().getArray()
  const lpos = lobePrim.getAttribute('POSITION').getArray()
  const CELL = 0.004
  const grid = new Map()
  const key = (a, b, c) => `${a},${b},${c}`
  let reach = 0
  for (const lobe of removedLobes) {
    reach = Math.max(reach, lobe.size * POCKET_MARGIN)
    for (const t of lobe.tris) {
      for (let k = 0; k < 3; k++) {
        const v = lidx[t + k] * 3
        const kk = key(
          Math.floor(lpos[v] / CELL),
          Math.floor(lpos[v + 1] / CELL),
          Math.floor(lpos[v + 2] / CELL),
        )
        let bucket = grid.get(kk)
        if (!bucket) { bucket = []; grid.set(kk, bucket) }
        bucket.push(v)
      }
    }
  }

  const span = Math.ceil(reach / CELL)
  const idx = prim.getIndices().getArray()
  const pos = prim.getAttribute('POSITION').getArray()

  return filterTriangles(prim, (t) => {
    let x = 0; let y = 0; let z = 0
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k] * 3
      x += pos[v]; y += pos[v + 1]; z += pos[v + 2]
    }
    x /= 3; y /= 3; z /= 3

    const cx = Math.floor(x / CELL); const cy = Math.floor(y / CELL); const cz = Math.floor(z / CELL)
    for (let a = cx - span; a <= cx + span; a++) {
      for (let b = cy - span; b <= cy + span; b++) {
        for (let c = cz - span; c <= cz + span; c++) {
          for (const v of grid.get(key(a, b, c)) ?? []) {
            if (Math.hypot(lpos[v] - x, lpos[v + 1] - y, lpos[v + 2] - z) <= reach) return false
          }
        }
      }
    }
    return true
  })
}


/**
 * Closes every boundary loop in a mesh with a triangle fan.
 *
 * After cutting the fat pockets out, the shell has open edges -- and an open
 * edge in a translucent shell is a hole you can see straight through. A
 * boundary edge is one used by exactly a single triangle; chaining those
 * gives the loops, and each loop is filled with a fan to its own centroid.
 *
 * A fan is flat, so it is only right for a roughly planar loop. That is what
 * these are: the cut follows a bounding box through a smooth shell, so the
 * openings it leaves are shallow. A loop that is not planar would show as a
 * facet rather than a hole, which is the better failure of the two.
 */
function capHoles(doc, meshPrefix) {
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(meshPrefix))
  const prim = mesh?.listPrimitives()[0]
  if (!prim) return 0

  const idx = Array.from(prim.getIndices().getArray())
  const semantics = prim.listSemantics()
  const attrs = Object.fromEntries(semantics.map(s => [s, Array.from(prim.getAttribute(s).getArray())]))
  const sizes = Object.fromEntries(semantics.map(s => [s, prim.getAttribute(s).getElementSize()]))
  const pos = attrs.POSITION

  // Weld by position so edges shared between duplicated corners are seen as
  // shared. Without this every triangle looks like an island and every edge
  // like a boundary.
  const canon = new Map()
  const key3 = i => `${Math.round(pos[i * 3] * 1e6)},${Math.round(pos[i * 3 + 1] * 1e6)},${Math.round(pos[i * 3 + 2] * 1e6)}`
  const rep = new Int32Array(pos.length / 3)
  for (let i = 0; i < rep.length; i++) {
    const k = key3(i)
    if (!canon.has(k)) canon.set(k, i)
    rep[i] = canon.get(k)
  }

  const edgeCount = new Map()
  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  for (let t = 0; t < idx.length; t += 3) {
    const a = rep[idx[t]]; const b = rep[idx[t + 1]]; const c = rep[idx[t + 2]]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v)
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1)
    }
  }

  /**
   * Directed boundary edges, as a multimap.
   *
   * A plain vertex->vertex map loses loops: a pinch point where two openings
   * meet has two outgoing boundary edges, the second `set` overwrites the
   * first, and one hole is never capped. That left a visible hole in the
   * shell after the first attempt. Edges are consumed as they are walked, so
   * every one ends up in exactly one loop.
   */
  const outgoing = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    const a = rep[idx[t]]; const b = rep[idx[t + 1]]; const c = rep[idx[t + 2]]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (edgeCount.get(edgeKey(u, v)) !== 1) continue
      let list = outgoing.get(u)
      if (!list) { list = []; outgoing.set(u, list) }
      list.push(v)
    }
  }
  if (!outgoing.size) return 0

  let added = 0
  for (const [start, list] of outgoing) {
    while (list.length) {
      const loop = [start]
      let cur = list.pop()
      // Bounded by the edge count: every step consumes one edge.
      while (cur !== undefined && cur !== start && loop.length < edgeCount.size) {
        loop.push(cur)
        cur = outgoing.get(cur)?.pop()
      }
      if (loop.length < 3) continue

      // One new vertex at the loop's centroid, attributes averaged so
      // normals and UVs stay in family with their neighbours.
      const centre = attrs.POSITION.length / 3
      for (const sem of semantics) {
        const size = sizes[sem]
        for (let c = 0; c < size; c++) {
          let sum = 0
          for (const v of loop) sum += attrs[sem][v * size + c]
          attrs[sem].push(sum / loop.length)
        }
      }
      /**
       * Wind the fan to agree with the surface it is patching.
       *
       * A fan built in whatever order the loop happened to be walked faces
       * an arbitrary way, and a backwards-facing patch is culled -- so the
       * hole is still a hole, which is exactly what the first capped build
       * looked like. The loop's own vertex normals say which way is out.
       */
      const nrm = [0, 1, 2].map((c) => {
        let sum = 0
        for (const v of loop) sum += attrs.NORMAL?.[v * 3 + c] ?? 0
        return sum / loop.length
      })
      const e1 = [0, 1, 2].map(c => attrs.POSITION[loop[1] * 3 + c] - attrs.POSITION[loop[0] * 3 + c])
      const e2 = [0, 1, 2].map(c => attrs.POSITION[loop[2] * 3 + c] - attrs.POSITION[loop[0] * 3 + c])
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const flip = cross[0] * nrm[0] + cross[1] * nrm[1] + cross[2] * nrm[2] < 0

      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]
        const b = loop[(i + 1) % loop.length]
        if (flip) idx.push(centre, b, a)
        else idx.push(centre, a, b)
        added++
      }
    }
  }

  for (const sem of semantics) prim.getAttribute(sem).setArray(new Float32Array(attrs[sem]))
  prim.getIndices().setArray(
    attrs.POSITION.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
  )
  return added
}


const baseline = await io.read(SOURCE)
const baseLobes = baseline.getRoot().listMeshes().find(m => m.getName().startsWith(LOBES))
if (!baseLobes) throw new Error(`No ${LOBES} mesh in ${SOURCE}`)
const basePrim = baseLobes.listPrimitives()[0]
const { attached: baseAttached, orphans: baseOrphans } = dropOrphans(
  findIslands(basePrim), basePrim, buildDuctIndex(baseline),
)
console.log(
  `source: ${baseAttached.length + baseOrphans.length} lobe islands, `
  + `${basePrim.getIndices().getCount() / 3} triangles`,
)
for (const o of baseOrphans) {
  console.log(
    `  ORPHAN dropped: ${String(o.tris.length).padStart(5)} tris, `
    + `${o.ductDistance.toFixed(5)} from the nearest duct`,
  )
}
console.log(`baseline after filtering: ${baseAttached.length} lobes\n`)

for (const target of TARGETS) {
  const doc = await io.read(SOURCE)
  const mesh = doc.getRoot().listMeshes().find(m => m.getName().startsWith(LOBES))
  const prim = mesh.listPrimitives()[0]
  // Orphans go first, so every ratio below is a fraction of the REAL lobe
  // count rather than of a count inflated by debris.
  const { attached: islands, orphans } = dropOrphans(
    findIslands(prim), prim, buildDuctIndex(doc),
  )

  // Ordered by centroid height, so an even stride thins the breast evenly
  // rather than clearing it from one end.
  islands.sort((a, b) => a.centroid[1] - b.centroid[1])
  const wanted = Math.round(islands.length * target.ratio)

  let kept = islands
  let duplicates = []
  if (wanted < islands.length) {
    const picks = new Set(evenPicks(islands.length, wanted))
    kept = islands.filter((_, i) => picks.has(i))
  }
  else if (wanted > islands.length) {
    const extra = wanted - islands.length
    // `extra` can exceed the number of lobes, so the picks cycle: at +100%
    // every lobe is duplicated once, and beyond that some are duplicated
    // twice.
    const sources = Array.from({ length: extra }, (_, k) => islands[k % islands.length])
    duplicates = planDuplicates(
      sources,
      prim,
      ductVertices(doc),
      islands.map(i => i.centroid),
      forbiddenZone(doc),
    )
  }

  // Everything leaving the model: the lobes this density does not want, plus
  // the debris the orphan filter rejected. Both were hiding duct geometry.
  const removed = [...islands.filter(i => !kept.includes(i)), ...orphans]

  // Diagnostic only: DEBUG_TINT=<mesh-prefix> repaints one mesh bright green
  // so a render can attribute what is on screen to it. Never set in a real
  // build; the flag exists because guessing which mesh a colour belongs to
  // has already cost two wrong fixes.
  if (process.env.DEBUG_TINT && !['atlas', 'nofat'].includes(process.env.DEBUG_TINT)) {
    // Clone before tinting: several meshes share one material object here,
    // so setting the colour in place recolours all of them and proves
    // nothing. That mistake cost one whole diagnostic round.
    for (const m of doc.getRoot().listMeshes()) {
      if (!m.getName().startsWith(process.env.DEBUG_TINT)) continue
      for (const pr of m.listPrimitives()) {
        const clone = pr.getMaterial()?.clone()
        if (!clone) continue
        clone.setBaseColorFactor([0, 1, 0, 1])
        pr.setMaterial(clone)
      }
    }
  }
  if (process.env.DEBUG_TINT === 'nofat') {
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh()?.getName().startsWith('VH_F_fat_L')) node.dispose()
    }
  }
  if (process.env.DEBUG_TINT === 'atlas') {
    // One distinct colour per MESH, and each primitive gets its own material
    // clone first -- several meshes here share `gland_mat`, so tinting in
    // place recolours all of them at once and the test proves nothing. The
    // fat shell is dropped so nothing is occluded.
    const palette = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0],
      [1, 0, 1], [0, 1, 1], [1, 0.5, 0], [0.5, 0, 1],
    ]
    let i = 0
    for (const m of doc.getRoot().listMeshes()) {
      const colour = palette[i % palette.length]
      console.log(`  atlas: ${m.getName()} -> rgb(${colour.map(v => Math.round(v * 255)).join(',')})`)
      for (const pr of m.listPrimitives()) {
        const clone = pr.getMaterial()?.clone()
        if (!clone) continue
        clone.setBaseColorFactor([...colour, 1])
        pr.setMaterial(clone)
      }
      i++
    }
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh()?.getName().startsWith('VH_F_fat_L')) node.dispose()
    }
  }

  const tris = rewriteLobes(doc, prim, kept, duplicates)
  // The duct terminal that sat inside each removed lobe. Safe by bounding
  // box: the duct mesh is all interior tubing, with no outer skin to hole.
  const ductDropped = dropInsideBoxes(doc, removed, DUCTS)

  /**
   * The fat shell's cavity around each removed lobe, cut out and CAPPED.
   *
   * The shell is moulded with a pocket at every lobe's position. Remove the
   * lobe and the empty pocket shows through the translucent shell as a pale
   * lobe-shaped ghost -- what the human kept reporting as "yellow lobes",
   * confirmed by tinting the fat green at runtime and watching them turn
   * green with it.
   *
   * Three cheaper ideas failed first, and the failures are the reason this
   * one caps: cutting by the full bounding box removed every ghost but
   * punched a hole clean through the outer skin; a surface-proximity margin
   * small enough to spare the skin missed the pocket entirely; shrinking the
   * box left speckled remnants at every factor tried. Recolouring the lobe
   * as fat instead of deleting it changed nothing at all -- the recoloured
   * lobe and the pocket it sits in are the same shape in the same place.
   *
   * So: cut by the full box, which is what actually clears the ghost, then
   * close every boundary loop the cut opened. `capHoles` is what makes the
   * cut safe.
   */
  const fatDropped = dropInsideBoxes(doc, removed, FAT)
  const capped = fatDropped ? capHoles(doc, FAT) : 0

  /**
   * Post-condition, and the reason it exists: the previous version of the
   * duplication translated copies through the fat toward the lobe cloud's
   * centre, which detached every one of them from its duct -- manufacturing
   * exactly the defect the orphan filter above removes. Nothing caught it
   * until a human looked at the render. Re-running the same filter over the
   * FINISHED mesh is what would have.
   */
  const { orphans: leftover } = dropOrphans(findIslands(prim), prim, buildDuctIndex(doc))
  if (leftover.length) {
    throw new Error(
      `${target.dir}: ${leftover.length} lobe(s) ended up detached from the duct tree `
      + `(${leftover.map(o => o.ductDistance.toFixed(5)).join(', ')}). A duplicate was placed `
      + 'somewhere no duct reaches.',
    )
  }
  const out = join(root, 'resource-backend/static/modelView', target.dir, 'left', target.file)

  console.log(
    `${target.dir}  ${String(Math.round(target.ratio * 100)).padStart(4)}%  `
    + `${String(kept.length + duplicates.length).padStart(2)} lobes `
    + `(${kept.length} kept${duplicates.length ? ` + ${duplicates.length} added` : ''}), `
    + `${tris.toLocaleString()} triangles`
    + (fatDropped ? `, fat: -${fatDropped.toLocaleString()} tris +${capped} cap tris` : '')
    + (ductDropped ? `, duct: -${ductDropped.toLocaleString()} tris` : '')
    + ` -> ${target.file}`,
  )
  if (DRY_RUN) continue

  mkdirSync(dirname(out), { recursive: true })
  const raw = join(root, 'resource-backend/static/modelView', target.dir, 'left', `.raw-${target.file}`)
  await io.write(raw, doc)

  // Same compression the asset pipeline applies, so these files are
  // interchangeable with anything `yarn assets` produces.
  /**
   * `--palette false` and `--join false` are the difference between the
   * model looking right and looking wrong, and neither is a size decision.
   *
   * `palette` bakes every material's flat colour into one tiny atlas -- here
   * a 32x4 image -- and rewrites the meshes to sample it, merging them onto a
   * single material. `--texture-compress webp` then runs that atlas through a
   * LOSSY encoder, and at four pixels tall a lossy encoder bleeds neighbouring
   * cells into each other. The result: mammary lobes sampling the duct
   * material's `#dec494` and rendering pale yellow among the pink ones. Three
   * rounds of geometry analysis found nothing wrong with the geometry, because
   * nothing was: the colour was destroyed in compression.
   *
   * `join` is disabled for a related reason. It merged the source's eight
   * named meshes down to three, and `tintFatLayer` finds the fat shell by
   * node name -- a merge that swept another mesh into `VH_F_fat_L` would paint
   * it translucent amber with no error anywhere.
   *
   * Draco still does the real work: 13.7MB of geometry to ~780KB. The palette
   * atlas it stops producing was 164 bytes.
   */
  const cli = join(root, 'resource-frontend/node_modules/@gltf-transform/cli/bin/cli.js')
  execFileSync(process.execPath, [
    cli, 'optimize', raw, out,
    '--compress', 'draco',
    '--texture-compress', 'webp',
    '--simplify', 'false',
    '--palette', 'false',
    '--join', 'false',
  ], { stdio: 'inherit' })
  execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(raw)})`])
}
