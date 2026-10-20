import { expect, test } from 'vitest'
import { gunzipSync } from 'fflate'
import { SVGPathData } from 'svg-pathdata'
import { roundSvgCoordinates, svgFileBytes, validateSvgOptions, decodeSvgFileBytes } from './export-options'

test('SVG options are bounded and reject unsupported native/raster knobs', () => {
  expect(validateSvgOptions()).toEqual({ scale: 1, precision: undefined, compression: 'none', textMode: 'outlines' })
  for (const options of [{ precision: -1 }, { precision: 9 }, { precision: 1.5 }, { scale: 0 }, { scale: Infinity }, { scale: 129 }, { compression: 'zip' }, { textMode: 'html' }, { quality: 80 }, { width: 100 }]) expect(() => validateSvgOptions(options as never)).toThrow()
})
test('coordinate precision uses parsed path commands while preserving text, flags, IDs, colors and resources', () => {
  const source = '<svg width="12.1234" height="20.5678" viewBox="0 0 12.1234 20.5678"><title>1.234 d="9.876"</title><path id="node-1.234" fill="#123456" d="M.12345 -.98765A2.3456 4.5678 30.123 0 1 9.8765 12.3456"/><image href="data:image/png;base64,1.234"/><g transform="matrix(1 0 0 1 1.2345 2.3456)"/></svg>'
  expect(roundSvgCoordinates(source)).toBe(source)
  const rounded = roundSvgCoordinates(source, 2)
  expect(rounded).toContain('<title>1.234 d="9.876"</title>')
  expect(rounded).toContain('id="node-1.234" fill="#123456"')
  expect(rounded).toContain('href="data:image/png;base64,1.234"')
  expect(rounded).toContain('matrix(1 0 0 1 1.23 2.35)')
  const commands = new SVGPathData(/ d="([^"]*)"\//.exec(rounded)![1]).commands
  expect(commands[0]).toMatchObject({ x: .12, y: -.99 })
  expect(commands[1]).toMatchObject({ rX: 2.35, rY: 4.57, lArcFlag: 0, sweepFlag: 1 })
})
test('rounding rejects structurally degenerate output', () => {
  for (const body of ['<g transform="matrix(.001 0 0 .001 0 0)"/>', '<path d="M0 0 A.001 1 0 0 1 2 3"/>', '<svg viewBox="0 0 .001 1"/>', '<rect width=".001"/>', '<linearGradient x1="0" y1="0" x2=".001" y2="0"/>']) expect(() => roundSvgCoordinates(body, 0)).toThrow(/collapses/)
})
test('SVGZ gzip is deterministic and decompression restores exact UTF-8 serialization', () => {
  const source = '<svg><title>矢量原始精度 1.23456789</title></svg>'
  const bytes = svgFileBytes(source, 'gzip')
  expect(bytes).toEqual(svgFileBytes(source, 'gzip'))
  expect(new TextDecoder().decode(gunzipSync(bytes))).toBe(source)
  expect(new TextDecoder().decode(svgFileBytes(source))).toBe(source)
})

test('bounded SVGZ decoder restores exports and rejects expansion, corruption and multiple members', () => {
  const source = '<svg><title>矢量</title></svg>', bytes = svgFileBytes(source, 'gzip')
  expect(decodeSvgFileBytes(bytes, true)).toBe(source)
  expect(() => decodeSvgFileBytes(svgFileBytes('x'.repeat(10000), 'gzip'), true, 100)).toThrow(/budget/)
  const forged = svgFileBytes('x'.repeat(10000), 'gzip'); forged.fill(0, forged.length - 4)
  expect(() => decodeSvgFileBytes(forged, true, 100)).toThrow(/budget/)
  const corrupt = bytes.slice(); corrupt[corrupt.length - 8] ^= 1
  expect(() => decodeSvgFileBytes(corrupt, true)).toThrow(/checksum/)
  expect(() => decodeSvgFileBytes(new Uint8Array([...bytes, ...bytes]), true)).toThrow(/member/)
})
