import { splitNrrd } from './nrrd-gzip.mjs'

/**
 * copper3d 4.1 refuses an NRRD that declares no `space`. Several catalogue
 * files were written without one, so this adds an identity left-posterior-
 * superior frame to such headers. Only the header text is rewritten; the data
 * block is never touched.
 */

const SPACE_LINES = [
  'space: left-posterior-superior',
  'space directions: (1,0,0) (0,1,0) (0,0,1)',
  'space origin: (0,0,0)',
]

// Fields that carry one entry per axis. A singleton axis is removed from each
// of them together with its `sizes` entry.
const PER_AXIS_FIELDS = new Set([
  'kinds', 'spacings', 'labels', 'units', 'centers', 'thicknesses', 'axis mins', 'axis maxs',
])

// Quoted strings (labels, units) may contain spaces, so tokenise around them.
const TOKEN = /"[^"]*"|\S+/g

function fieldName(line) {
  const i = line.indexOf(':')
  return i === -1 ? null : line.slice(0, i)
}

function dropLastEntry(line) {
  const i = line.indexOf(':')
  const tokens = line.slice(i + 1).match(TOKEN) ?? []
  tokens.pop()
  return `${line.slice(0, i + 1)} ${tokens.join(' ')}`
}

export function orientNrrdHeader(header) {
  const eol = header.includes('\r\n') ? '\r\n' : '\n'
  const lines = header.split(eol)
  if (lines.some(line => fieldName(line) === 'space')) return header

  const dimIndex = lines.findIndex(line => fieldName(line) === 'dimension')
  const sizesIndex = lines.findIndex(line => fieldName(line) === 'sizes')
  if (dimIndex === -1 || sizesIndex === -1) {
    throw new Error('NRRD header has no dimension or sizes field')
  }
  const dimension = Number(lines[dimIndex].slice(lines[dimIndex].indexOf(':') + 1).trim())
  const sizes = lines[sizesIndex].slice(lines[sizesIndex].indexOf(':') + 1).trim().split(/\s+/)

  if (dimension === 4) {
    if (sizes[sizes.length - 1] !== '1') {
      throw new Error(`Cannot orient NRRD: dimension 4 with last size ${sizes[sizes.length - 1]} (only a singleton fourth axis can be squeezed)`)
    }
    lines[dimIndex] = 'dimension: 3'
    for (let i = 0; i < lines.length; i++) {
      const name = fieldName(lines[i])
      if (name === 'sizes' || PER_AXIS_FIELDS.has(name)) lines[i] = dropLastEntry(lines[i])
    }
  } else if (dimension !== 3) {
    throw new Error(`Cannot orient NRRD: unsupported dimension ${lines[dimIndex].trim()}`)
  }

  lines.splice(sizesIndex + 1, 0, ...SPACE_LINES)
  return lines.join(eol)
}

export function orientNrrd(buf) {
  const { header, data } = splitNrrd(buf)
  const oriented = orientNrrdHeader(header)
  if (oriented === header) return buf
  return Buffer.concat([Buffer.from(oriented, 'ascii'), data])
}
