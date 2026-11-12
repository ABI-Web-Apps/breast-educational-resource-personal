import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gzipNrrd, rewriteEncoding, splitNrrd } from '../../scripts/lib/nrrd-gzip.mjs'

/** Build a minimal valid NRRD: header + blank line + binary body. */
function makeNrrd(encoding = 'raw', data = Buffer.from([1, 2, 3, 4]), eol = '\n'): Buffer {
  const header = [
    'NRRD0004',
    '# Complete NRRD file format specification at:',
    'type: unsigned char',
    'dimension: 3',
    'sizes: 2 2 1',
    `encoding: ${encoding}`,
    'endian: little',
    '',
    '',
  ].join(eol)
  return Buffer.concat([Buffer.from(header, 'ascii'), data])
}

describe('splitNrrd', () => {
  it('splits at the blank line that terminates the header', () => {
    const { header, data } = splitNrrd(makeNrrd())
    expect(header).toContain('NRRD0004')
    expect(header).toContain('encoding: raw')
    expect(data).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('throws when there is no header terminator', () => {
    expect(() => splitNrrd(Buffer.from('NRRD0004\ntype: short\n', 'ascii')))
      .toThrow(/header terminator/i)
  })

  it('does not mistake a 0x0A 0x0A byte pair inside the data block for the terminator', () => {
    // A naive re-scan (or an off-by-one in the marker length) could still
    // land on the right split by luck. Put a literal \n\n as the very first
    // two bytes of the data block -- right after the real terminator -- so
    // only correctly stopping at the header's own blank line passes.
    const data = Buffer.from([0x0a, 0x0a, 9, 8, 7])
    const { header, data: split } = splitNrrd(makeNrrd('raw', data))
    expect(header).toContain('encoding: raw')
    expect(split).toEqual(data)
  })

  it('splits a CRLF-terminated header at \\r\\n\\r\\n, not at a coincidental \\n\\n in the data', () => {
    const data = Buffer.from([0x0a, 0x0a, 1, 2, 3])
    const { header, data: split } = splitNrrd(makeNrrd('raw', data, '\r\n'))
    expect(header).toContain('encoding: raw')
    expect(header.endsWith('\r\n\r\n')).toBe(true)
    expect(split).toEqual(data)
  })

  it('reassembling header + data reproduces the original buffer exactly', () => {
    const buf = makeNrrd('raw', Buffer.from([9, 8, 7, 6, 5]))
    const { header, data } = splitNrrd(buf)
    expect(Buffer.concat([Buffer.from(header, 'ascii'), data])).toEqual(buf)
  })
})

describe('rewriteEncoding', () => {
  it('replaces the encoding field', () => {
    const out = rewriteEncoding('type: short\nencoding: raw\nendian: little\n', 'gzip')
    expect(out).toContain('encoding: gzip')
    expect(out).not.toContain('encoding: raw')
  })

  it('leaves every other field untouched', () => {
    const out = rewriteEncoding('type: short\nencoding: raw\nendian: little\n', 'gzip')
    expect(out).toContain('type: short')
    expect(out).toContain('endian: little')
  })

  it('throws when the header has no encoding field', () => {
    expect(() => rewriteEncoding('type: short\n', 'gzip')).toThrow(/encoding/i)
  })

  it('preserves a CRLF header\'s line-ending style on the rewritten line', () => {
    // \s* before the end-of-line anchor is greedy enough to swallow a
    // trailing \r along with the value, so a naive replace drops it and
    // leaves the encoding line ending in a bare \n while its neighbours
    // still end \r\n.
    const header = 'type: short\r\nencoding: raw\r\nendian: little\r\n'
    expect(rewriteEncoding(header, 'gzip')).toBe('type: short\r\nencoding: gzip\r\nendian: little\r\n')
  })
})

describe('gzipNrrd', () => {
  it('produces a file whose data block gunzips back to the original', () => {
    const original = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2])
    const out = gzipNrrd(makeNrrd('raw', original))
    const { header, data } = splitNrrd(out)
    expect(header).toContain('encoding: gzip')
    expect(gunzipSync(data)).toEqual(original)
  })

  it('is a no-op for an already gzipped file', () => {
    const already = gzipNrrd(makeNrrd())
    expect(gzipNrrd(already)).toEqual(already)
  })

  it('is also a no-op for the "gz" spelling of gzip encoding', () => {
    const alreadyGz = makeNrrd('gz')
    expect(gzipNrrd(alreadyGz)).toEqual(alreadyGz)
  })

  it('throws, naming the encoding, for anything that is neither raw nor already compressed', () => {
    expect(() => gzipNrrd(makeNrrd('ascii'))).toThrow(/ascii/)
  })

  it('round-trips a CRLF-terminated NRRD end to end', () => {
    // Exercises gzipNrrd itself, not just splitNrrd/rewriteEncoding in
    // isolation, on a CRLF fixture: the output must still gunzip back to the
    // original data AND still be a well-formed CRLF header that splitNrrd
    // can parse again.
    const original = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2])
    const out = gzipNrrd(makeNrrd('raw', original, '\r\n'))
    const { header, data } = splitNrrd(out)
    expect(header).toContain('encoding: gzip\r\n')
    expect(header.endsWith('\r\n\r\n')).toBe(true)
    expect(gunzipSync(data)).toEqual(original)
  })
})
