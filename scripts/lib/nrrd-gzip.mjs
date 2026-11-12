import { gzipSync } from 'node:zlib'

/**
 * An NRRD header is ASCII text, separated from the binary data block by a
 * single blank line. That blank line is usually \n\n, but a header written
 * with Windows line endings uses \r\n\r\n instead.
 * Reference: https://teem.sourceforge.net/nrrd/format.html
 */
export function splitNrrd(buf) {
  const lfIndex = buf.indexOf('\n\n')
  const crlfIndex = buf.indexOf('\r\n\r\n')
  // Compare raw byte offsets rather than preferring one style outright: the
  // 4-byte sequence \r\n\r\n never contains \n\n as a substring (it is
  // 0D 0A 0D 0A), so whichever marker has the smaller index is genuinely the
  // first blank line in the buffer -- and therefore the true header
  // terminator. Without this, a CRLF header falls through to \n\n and the
  // scan lands on the first coincidental 0A 0A byte pair inside the binary
  // data instead, silently corrupting the split.
  let marker
  let terminatorLength
  if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex <= crlfIndex)) {
    marker = lfIndex
    terminatorLength = 2
  } else if (crlfIndex !== -1) {
    marker = crlfIndex
    terminatorLength = 4
  } else {
    throw new Error('Not a valid attached NRRD: no blank-line header terminator found')
  }
  return {
    // Keep the terminating blank line, so reassembly needs no separator
    header: buf.subarray(0, marker + terminatorLength).toString('ascii'),
    data: buf.subarray(marker + terminatorLength),
  }
}

// Capture the line's trailing \r (if any) separately from the value, rather
// than letting a generic \s*$ swallow it: \r is whitespace, so a pattern
// like /^encoding:\s*\S+\s*$/m matches (and therefore replaces) the \r along
// with the value on a CRLF header, leaving that one line ending in a bare
// \n while every other header line still ends \r\n.
const ENCODING_LINE = /^(encoding:\s*)\S+(\r?)$/m

export function rewriteEncoding(header, encoding) {
  if (!ENCODING_LINE.test(header)) {
    throw new Error('NRRD header has no encoding field')
  }
  return header.replace(ENCODING_LINE, (_match, prefix, cr) => `${prefix}${encoding}${cr}`)
}

export function readEncoding(header) {
  const m = header.match(/^encoding:\s*(\S+)\s*$/m)
  if (!m) throw new Error('NRRD header has no encoding field')
  return m[1]
}

// NRRD spells gzip encoding as either "gzip" or "gz" -- both are legal and
// both mean the data block is already deflated.
const ALREADY_GZIPPED = new Set(['gzip', 'gz'])

/**
 * Re-encode raw -> gzip. Files already encoded as gzip (or its "gz" spelling)
 * are returned unchanged. three's NRRDLoader reads gzip natively via fflate,
 * so the rendering layer needs no changes.
 *
 * Any other encoding (ascii, hex, text, bzip2, ...) is rejected rather than
 * silently deflated: NRRD's ascii/hex/text encodings store the data block as
 * decimal or hex text, not raw bytes, so gzipping them would produce a file
 * that claims "encoding: gzip" but whose decompressed bytes are text, not a
 * voxel buffer -- a corrupt volume with no error at write time.
 */
export function gzipNrrd(buf) {
  const { header, data } = splitNrrd(buf)
  const encoding = readEncoding(header)
  if (ALREADY_GZIPPED.has(encoding)) return buf
  if (encoding !== 'raw') {
    throw new Error(`Cannot gzip-encode NRRD: unsupported encoding "${encoding}" (only "raw" data blocks can be re-encoded)`)
  }
  return Buffer.concat([
    Buffer.from(rewriteEncoding(header, 'gzip'), 'ascii'),
    gzipSync(data, { level: 9 }),
  ])
}
