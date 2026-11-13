import { describe, expect, it } from 'vitest'
import { orientNrrd, orientNrrdHeader } from '../../scripts/lib/nrrd-orient.mjs'
import { splitNrrd } from '../../scripts/lib/nrrd-gzip.mjs'

describe('orientNrrdHeader', () => {
  it('adds identity LPS geometry to a header with no space', () => {
    const out = orientNrrdHeader('NRRD0005\ntype: uint16\ndimension: 3\nsizes: 334 823 19\nendian: little\nencoding: gzip\n\n')
    expect(out).toContain('space: left-posterior-superior\n')
    expect(out).toContain('space directions: (1,0,0) (0,1,0) (0,0,1)\n')
    expect(out).toContain('space origin: (0,0,0)\n')
    expect(out.indexOf('space:')).toBeGreaterThan(out.indexOf('sizes:'))
  })

  it('squeezes a trailing singleton fourth axis', () => {
    const out = orientNrrdHeader('NRRD0005\ntype: uint16\ndimension: 4\nsizes: 998 1229 40 1\nencoding: gzip\n\n')
    expect(out).toContain('dimension: 3\n')
    expect(out).toContain('sizes: 998 1229 40\n')
  })

  it('drops the last entry of per-axis fields when squeezing', () => {
    const out = orientNrrdHeader(
      'NRRD0005\ndimension: 4\nsizes: 4 5 6 1\nkinds: domain domain domain list\nspacings: 1 2 3 nan\nlabels: "a" "b" "c" "d"\nencoding: gzip\n\n',
    )
    expect(out).toContain('kinds: domain domain domain\n')
    expect(out).toContain('spacings: 1 2 3\n')
    expect(out).toContain('labels: "a" "b" "c"\n')
  })

  it('leaves a header that already has a space untouched', () => {
    const h = 'NRRD0004\ntype: short\ndimension: 3\nspace: left-posterior-superior\nsizes: 2 2 2\nencoding: gzip\n\n'
    expect(orientNrrdHeader(h)).toBe(h)
  })

  it('keeps CRLF line endings', () => {
    const out = orientNrrdHeader('NRRD0005\r\ndimension: 4\r\nsizes: 2 3 4 1\r\nencoding: gzip\r\n\r\n')
    expect(out).toContain('sizes: 2 3 4\r\n')
    expect(out).toContain('space: left-posterior-superior\r\n')
    expect(out).toContain('space directions: (1,0,0) (0,1,0) (0,0,1)\r\n')
    expect(out).toContain('space origin: (0,0,0)\r\n')
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('refuses a 4-D header whose last axis is not 1', () => {
    expect(() => orientNrrdHeader('NRRD0005\ndimension: 4\nsizes: 2 2 2 3\nencoding: gzip\n\n')).toThrow(/dimension/)
  })

  it('refuses any other dimension', () => {
    expect(() => orientNrrdHeader('NRRD0005\ndimension: 2\nsizes: 2 2\nencoding: gzip\n\n')).toThrow(/dimension/)
  })

  it('is idempotent', () => {
    const once = orientNrrdHeader('NRRD0005\ndimension: 4\nsizes: 2 2 2 1\nencoding: gzip\n\n')
    expect(orientNrrdHeader(once)).toBe(once)
  })
})

describe('orientNrrd', () => {
  it('leaves the data block byte-identical', () => {
    const data = Buffer.from([0x0a, 0x0a, 0, 255, 1, 2, 3])
    const buf = Buffer.concat([
      Buffer.from('NRRD0005\ndimension: 3\nsizes: 2 2 2\nencoding: raw\n\n', 'ascii'),
      data,
    ])
    const out = orientNrrd(buf)
    expect(splitNrrd(out).header).toContain('space: left-posterior-superior')
    expect(splitNrrd(out).data.equals(data)).toBe(true)
  })

  it('returns the same buffer when no change is needed', () => {
    const buf = Buffer.from('NRRD0004\ndimension: 3\nspace: left-posterior-superior\nsizes: 2 2 2\nencoding: raw\n\nxx', 'ascii')
    expect(orientNrrd(buf)).toBe(buf)
  })
})
