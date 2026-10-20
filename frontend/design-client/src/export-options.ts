import { gzipSync, Gunzip } from 'fflate'
import { SVGPathData } from 'svg-pathdata'
import { svgNumberList } from './svg-values'

/** SVG scale changes viewport dimensions, not raster resolution. Precision is
 * opt-in lossy coordinate rounding; gzip only compresses the serialized bytes. */
export type SvgExportOptions = { scale?: number; precision?: number; compression?: 'none' | 'gzip'; textMode?: 'outlines' | 'editable' }
export const SVG_OPTION_SCHEMA = {
  textMode: { type: 'string', enum: ['outlines', 'editable'], description: 'Outlines preserve visual geometry (default). Editable text references unembedded fonts and may render differently; advanced typography is rejected.' },
  scale: { type: 'number', minimum: 0.001, maximum: 128, description: 'SVG viewport size multiplier; not raster resolution.' },
  precision: { type: 'integer', minimum: 0, maximum: 8, description: 'Opt-in lossy coordinate decimal places. Omit to preserve existing precision.' },
  compression: { type: 'string', enum: ['none', 'gzip'], description: 'Lossless SVG container compression; gzip produces .svgz.' },
}
export function validateSvgOptions(input: SvgExportOptions = {}): Required<Pick<SvgExportOptions, 'scale' | 'compression' | 'textMode'>> & Pick<SvgExportOptions, 'precision'> {
  for (const key of Object.keys(input)) if (!['scale', 'precision', 'compression', 'textMode'].includes(key)) throw new Error(`Unsupported SVG option: ${key}`)
  const { scale = 1, precision, compression = 'none', textMode = 'outlines' } = input
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.001 || scale > 128) throw new Error('SVG scale must be between 0.001 and 128')
  if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 8)) throw new Error('SVG precision must be an integer between 0 and 8')
  if (!['none', 'gzip'].includes(compression)) throw new Error('SVG compression must be none or gzip')
  if (!['outlines', 'editable'].includes(textMode)) throw new Error('SVG textMode must be outlines or editable')
  return { scale, precision, compression, textMode }
}
export function roundSvgCoordinates(source: string, precision?: number): string {
  if (precision === undefined) return source
  validateSvgOptions({ precision })
  const round = (n: number) => Number(n.toFixed(precision))
  // Only attributes of actual tags are touched. Never text, IDs, URLs, colors,
  // styles or embedded assets. Path commands use the existing full SVG parser.
  return source.replace(/<[^>]+>/g, tag => {
    const rounded = tag.replace(/\s(d|viewBox|transform|gradientTransform|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|stroke-width)="([^"]*)"/g, (attribute, name: string, value: string) => {
      if (name === 'd') {
        const path = new SVGPathData(value)
        for (const command of path.commands) for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'rX', 'rY', 'xRot']) {
          const record = command as unknown as Record<string, unknown>
          if (typeof record[key] === 'number') {
            const original = record[key] as number, next = round(original)
            if (['rX', 'rY'].includes(key) && original !== 0 && next === 0) throw new Error('SVG precision collapses an arc radius; increase precision')
            record[key] = next
          }
        }
        return ` ${name}="${path.encode()}"`
      }
      if (name === 'transform' || name === 'gradientTransform') {
        const matrix = /^matrix\(([^)]+)\)$/.exec(value)
        if (!matrix) throw new Error('SVG precision requires a matrix transform')
        const values = svgNumberList(matrix[1], name).map(round)
        if (values.length !== 6 || values[0] * values[3] - values[1] * values[2] === 0) throw new Error('SVG precision collapses a transform; increase precision')
        return ` ${name}="matrix(${values.join(' ')})"`
      }
      if (name === 'viewBox') {
        const values = svgNumberList(value, name).map(round)
        if (values.length !== 4 || values[2] <= 0 || values[3] <= 0) throw new Error('SVG precision collapses the viewport; increase precision')
        return ` ${name}="${values.join(' ')}"`
      }
      // Percentage lengths are intentionally preserved, as are nonnumeric units.
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return attribute
      const original = Number(value), next = round(original)
      if (['width', 'height', 'r', 'rx', 'ry', 'stroke-width'].includes(name) && original > 0 && next === 0) throw new Error('SVG precision collapses a dimension; increase precision')
      return ` ${name}="${next}"`
    })
    if (/^<linearGradient\b/.test(tag)) {
      const endpoint = (text: string) => ['x1', 'y1', 'x2', 'y2'].map(key => Number(new RegExp(` ${key}="([^"]+)"`).exec(text)?.[1]))
      const before = endpoint(tag), after = endpoint(rounded)
      if (before.every(Number.isFinite) && after.every(Number.isFinite) && (before[0] !== before[2] || before[1] !== before[3]) && after[0] === after[2] && after[1] === after[3]) throw new Error('SVG precision collapses a gradient; increase precision')
    }
    return rounded
  })
}
export function svgFileBytes(source: string, compression: 'none' | 'gzip' = 'none'): Uint8Array {
  validateSvgOptions({ compression })
  const bytes = new TextEncoder().encode(source)
  return compression === 'gzip' ? gzipSync(bytes, { level: 6, mtime: 0 }) : bytes
}

/** Bound expansion before the XML parser sees compressed input. Feeding 1 KiB
 * compressed chunks also bounds transient inflater output before each callback. */
export function decodeSvgFileBytes(bytes: Uint8Array, compressed = false, maxBytes = 8 * 1024 * 1024): string {
  if (!bytes.length || bytes.length > maxBytes) throw new Error('SVG exceeds its byte budget')
  if (!compressed) return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (bytes.length < 18) throw new Error('Invalid SVGZ gzip header/trailer')
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8)
  if (trailer.getUint32(4, true) > maxBytes) throw new Error('Expanded SVGZ exceeds its byte budget')
  const parts: Uint8Array[] = []; let size = 0, crc = 0xffffffff
  const table = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0 })
  const decoder = new Gunzip(chunk => {
    size += chunk.length
    if (size > maxBytes) throw new Error('Expanded SVGZ exceeds its byte budget')
    for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8)
    parts.push(chunk.slice())
  })
  decoder.onmember = () => { throw new Error('SVGZ requires a single gzip member') }
  for (let at = 0; at < bytes.length; at += 1024) decoder.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length)
  if (size !== trailer.getUint32(4, true) || ((crc ^ 0xffffffff) >>> 0) !== trailer.getUint32(0, true)) throw new Error('SVGZ gzip checksum or size mismatch')
  const result = new Uint8Array(size); let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return new TextDecoder('utf-8', { fatal: true }).decode(result)
}
