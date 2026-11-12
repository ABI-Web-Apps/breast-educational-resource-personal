import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

/**
 * The generated icon set is committed, not built on demand, so these
 * assert the committed artefacts. Task 5's manifest references these
 * names verbatim; a rename that misses one would otherwise surface as an
 * icon that silently 404s on a home screen.
 *
 * Built by `yarn icons` (scripts/generate-pwa-icons.mjs).
 */
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

function png(name: string) {
  // `new URL(..., import.meta.url)` cannot be used here: Vite's
  // import-analysis plugin rewrites that literal pattern as an asset URL.
  // See the comment at the top of test/tokens.test.ts.
  return readFileSync(join(publicDir, name))
}

describe('generated PWA icons', () => {
  const expected: Record<string, number> = {
    'pwa-64x64.png': 64,
    'pwa-192x192.png': 192,
    'pwa-512x512.png': 512,
    'maskable-icon-512x512.png': 512,
    'apple-touch-icon-180x180.png': 180,
  }

  for (const [name, size] of Object.entries(expected)) {
    it(`${name} is a ${size}x${size} PNG`, () => {
      const buffer = png(name)
      expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG')
      expect(buffer.readUInt32BE(16)).toBe(size)
      expect(buffer.readUInt32BE(20)).toBe(size)
    })
  }

  it('the source is the legacy mark, unmodified', () => {
    // This pin is load-bearing, not incidental: several places in this
    // codebase promise that upgrading to a higher-resolution source is "no
    // code change, just drop a new public/icon.png and re-run `yarn
    // icons`" (see scripts/generate-pwa-icons.mjs's header). This test is
    // the cost that promise omits -- swapping the source is exactly what
    // should make this pin fail, and the fix is to update the three
    // numbers below to match the new file, not to loosen the assertion.
    const buffer = png('icon.png')
    expect(buffer.readUInt32BE(16)).toBe(88)
    expect(buffer.readUInt32BE(20)).toBe(88)
    expect(buffer.length).toBe(15214)
  })

  it('favicon.ico declares two PNG entries', () => {
    const buffer = png('favicon.ico')
    expect(buffer.readUInt16LE(0)).toBe(0) // reserved
    expect(buffer.readUInt16LE(2)).toBe(1) // type: icon
    expect(buffer.readUInt16LE(4)).toBe(2) // two sizes

    const sizes: number[] = []
    for (let i = 0; i < 2; i++) {
      const entry = 6 + i * 16
      sizes.push(buffer[entry]!)
      const length = buffer.readUInt32LE(entry + 8)
      const offset = buffer.readUInt32LE(entry + 12)
      // Each payload really is a PNG, and really is inside the file.
      expect(offset + length).toBeLessThanOrEqual(buffer.length)
      expect(buffer.subarray(offset + 1, offset + 4).toString('ascii')).toBe('PNG')
    }
    expect(sizes).toEqual([32, 48])
  })

  it('the maskable icon keeps its content inside the safe zone', () => {
    // Android crops a maskable icon to the centre 80%, so the mark must
    // not reach the edge. The generator pads it; this catches the padding
    // being dropped, which no dimension check would notice.
    const image = PNG.sync.read(png('maskable-icon-512x512.png'))
    const plain = PNG.sync.read(png('pwa-512x512.png'))

    function centreRow(source: { width: number, data: Buffer }) {
      const y = Math.floor(source.width / 2)
      return Array.from(
        { length: source.width },
        (_, x) => source.data[(y * source.width + x) * 4]!,
      )
    }

    const maskableRow = centreRow(image)
    const plainRow = centreRow(plain)
    const corner = image.data[0]!
    // The outer 5% of each side is untouched background on the maskable
    // version and, on the unpadded one, is not. (Conservative on purpose --
    // the real safe margin is wider, at MASKABLE_CONTENT = 0.8 i.e. 10% per
    // side -- this just has to land inside it, not match it exactly.)
    const edge = Math.floor(512 * 0.05)
    expect(maskableRow.slice(0, edge).every(v => v === corner)).toBe(true)
    expect(plainRow.slice(0, edge).every(v => v === corner)).toBe(false)
  })

  it('the maskable icon pads with the image\'s own background, not a foreign colour', () => {
    // A solid, uniform padding colour is not enough on its own: the source
    // has a solid white strip across its top row, so a naive corner sample
    // once produced solid white padding around a predominantly near-black
    // image -- uniform, and wrong. This compares the padding against the
    // plain 512 icon's own background instead of merely checking
    // uniformity.
    const maskable = PNG.sync.read(png('maskable-icon-512x512.png'))
    const plain = PNG.sync.read(png('pwa-512x512.png'))

    // The plain 512 icon is a 1:1 resize of the source with no padding.
    // Its top-left CORNER lands on the source's white strip, so that
    // corner is not representative -- but the vertical midpoint of its
    // left edge is clear of that strip and samples the mark's real
    // background instead.
    const midLeftY = Math.floor(plain.height / 2)
    const interiorAt = (channel: number) => plain.data[(midLeftY * plain.width) * 4 + channel]!

    // The maskable icon's own corner is solid padding: the resized
    // content is inset well clear of it.
    const paddingAt = (channel: number) => maskable.data[channel]!

    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(paddingAt(channel) - interiorAt(channel))).toBeLessThanOrEqual(40)
    }
  })
})
