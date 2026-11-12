/**
 * Generates the PWA icon set from `resource-frontend/public/icon.png`.
 *
 * ## Why this is hand-rolled
 *
 * `@vite-pwa/assets-generator` is the obvious tool and does not work here:
 * it depends on `sharp`, whose prebuilt native binary fails to load on
 * Node 24 / win32-x64 with ERR_DLOPEN_FAILED, reproducibly and after a
 * clean reinstall. `pngjs` is already a devDependency of `resource-frontend/` (see
 * resource-frontend/test-browser/stage.spec.ts:3), is pure JS, and has nothing native
 * to fail.
 *
 * Bilinear resampling is also the correct choice for this input rather
 * than a concession: the source is 88x88 and every output but the 64px
 * one is an UPSCALE, where a sharpening filter rings on edges instead of
 * inventing detail.
 *
 * ## The source's known limitation
 *
 * `resource-frontend/public/icon.png` is 88x88, recovered verbatim from the
 * legacy app. The 512px outputs are therefore soft. No higher-resolution
 * copy of it is known to exist.
 * Replacing the source with a vector render or a >=512px raster and
 * re-running this script is the entire fix, with no code change.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(repoRoot, 'resource-frontend', 'public')

// `pngjs` is a devDependency of resource-frontend/, but this script lives
// under scripts/, a sibling of it rather than an ancestor -- Node's ESM
// resolver only walks node_modules up from the importing file's own
// directory, so a bare `import ... from 'pngjs'` cannot see
// resource-frontend/node_modules. That is the repo's only Node project and
// the root has no package.json of its own; scripts/build-density-models.mjs
// hits the same problem for its own frontend-only devDependencies and
// resolves by explicit path
// rather than bare specifier, so this does the same (via
// `pathToFileURL` rather than their manual `file:///` string-building).
const { PNG } = await import(
  pathToFileURL(join(repoRoot, 'resource-frontend', 'node_modules', 'pngjs', 'lib', 'png.js')).href
)

/** Fraction of a maskable icon's width that must survive an aggressive
 *  platform crop. Android's maskable safe zone is the centre 80%. */
const MASKABLE_CONTENT = 0.8
/** Apple crops the corners of a touch icon into a squircle, so the mark
 *  gets a little breathing room there too -- less than maskable's, since
 *  the crop is much gentler. */
const APPLE_CONTENT = 0.9

/** Bilinear resample. `src` and the result are both RGBA PNG instances. */
function resize(src, size) {
  const out = new PNG({ width: size, height: size })
  const { width: sw, height: sh, data: sd } = src

  for (let y = 0; y < size; y++) {
    // Sample at pixel CENTRES (+0.5 / -0.5), otherwise the output is
    // shifted half a destination pixel up and left.
    const sy = ((y + 0.5) * sh) / size - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = Math.min(1, Math.max(0, sy - y0))

    for (let x = 0; x < size; x++) {
      const sx = ((x + 0.5) * sw) / size - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = Math.min(1, Math.max(0, sx - x0))

      const at = (y * size + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = sd[(y0 * sw + x0) * 4 + c]
        const p01 = sd[(y0 * sw + x1) * 4 + c]
        const p10 = sd[(y1 * sw + x0) * 4 + c]
        const p11 = sd[(y1 * sw + x1) * 4 + c]
        const top = p00 + (p01 - p00) * fx
        const bottom = p10 + (p11 - p10) * fx
        out.data[at + c] = Math.round(top + (bottom - top) * fy)
      }
    }
  }
  return out
}

/** Centres `content` on a `size`x`size` canvas filled with `bg` (RGBA). */
function onCanvas(content, size, bg) {
  const out = new PNG({ width: size, height: size })
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = bg[0]
    out.data[i + 1] = bg[1]
    out.data[i + 2] = bg[2]
    out.data[i + 3] = bg[3]
  }
  const offset = Math.round((size - content.width) / 2)
  for (let y = 0; y < content.height; y++) {
    for (let x = 0; x < content.width; x++) {
      const from = (y * content.width + x) * 4
      const to = ((y + offset) * size + (x + offset)) * 4
      // Source over, so a transparent source pixel keeps the background.
      const alpha = content.data[from + 3] / 255
      for (let c = 0; c < 3; c++) {
        out.data[to + c] = Math.round(
          content.data[from + c] * alpha + out.data[to + c] * (1 - alpha),
        )
      }
      out.data[to + 3] = Math.max(out.data[to + 3], content.data[from + 3])
    }
  }
  return out
}

/**
 * A Vista-style ICO: the directory entries point at whole PNG payloads
 * rather than at BMP bitmaps. Every browser this app targets reads it,
 * and it avoids hand-writing a BMP encoder with its bottom-up rows and
 * AND-mask padding.
 */
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = []
  let offset = 6 + entries.length * 16
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16)
    // 0 means 256 in this field; nothing here is that large, but the
    // encoding is the spec's and writing it out documents the limit.
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette size: none, this is truecolour
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    directory.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...directory, ...entries.map(e => e.png)])
}

/**
 * The mode colour of the source's one-pixel border ring, quantised so
 * near-identical near-blacks count as one bucket.
 *
 * A single corner sample is NOT safe here: this source has a solid white
 * strip across its entire top row (both (0,0) and (87,0) are pure white),
 * while the mark's real surroundings -- most of the left, right and
 * bottom edges -- are near-black (e.g. (0,10) = (13,14,14),
 * (0,44) = (20,20,21), (87,87) = (8,9,10)). A corner sample lands on the
 * white strip, which is a minority of the ring, and pads with a colour
 * that visibly contrasts with the image it borders -- the exact "visible
 * square behind it" this function exists to avoid.
 *
 * The border ring is 348 pixels for this 88x88 source: measured directly,
 * ~181 of those are some shade of near-black and 137 are the white strip,
 * with a long tail of a few greys. A per-channel mode at fine
 * granularity still loses to white as a single bucket, because the
 * near-black pixels form a gradient (roughly 8-30 per channel) that
 * splits across many fine buckets. Quantising to 32-wide buckets merges
 * that whole gradient into one bucket, which then clearly outnumbers the
 * white strip's single bucket -- verified against this actual source.
 */
function borderMode(src) {
  const { width, height, data } = src
  const QUANT = 32
  const buckets = new Map()
  function sample(x, y) {
    const i = (y * width + x) * 4
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = [r, g, b].map(v => Math.floor(v / QUANT)).join(',')
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count++
      bucket.sum[0] += r
      bucket.sum[1] += g
      bucket.sum[2] += b
    }
    else {
      buckets.set(key, { count: 1, sum: [r, g, b] })
    }
  }
  for (let x = 0; x < width; x++) {
    sample(x, 0)
    sample(x, height - 1)
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y)
    sample(width - 1, y)
  }
  let mode = null
  for (const bucket of buckets.values()) {
    if (!mode || bucket.count > mode.count) mode = bucket
  }
  return [
    Math.round(mode.sum[0] / mode.count),
    Math.round(mode.sum[1] / mode.count),
    Math.round(mode.sum[2] / mode.count),
    255,
  ]
}

const source = PNG.sync.read(readFileSync(join(publicDir, 'icon.png')))
const background = borderMode(source)

function write(name, png) {
  const buffer = PNG.sync.write(png)
  writeFileSync(join(publicDir, name), buffer)
  console.log(`${name}  ${png.width}x${png.height}  ${buffer.length}B`)
  return buffer
}

for (const size of [64, 192, 512]) {
  write(`pwa-${size}x${size}.png`, resize(source, size))
}

write(
  'maskable-icon-512x512.png',
  onCanvas(resize(source, Math.round(512 * MASKABLE_CONTENT)), 512, background),
)

write(
  'apple-touch-icon-180x180.png',
  onCanvas(resize(source, Math.round(180 * APPLE_CONTENT)), 180, background),
)

writeFileSync(
  join(publicDir, 'favicon.ico'),
  ico([32, 48].map(size => ({ size, png: PNG.sync.write(resize(source, size)) }))),
)
console.log('favicon.ico  32 + 48')
