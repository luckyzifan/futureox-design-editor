import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
// @ts-expect-error jsdom is the installed CPU XML test host.
import { JSDOM } from 'jsdom'
import { importSvg } from './import-svg'
import { apply, inverse } from './geometry'
import { validateDocument, type DesignDocument, type Matrix } from './model'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { svgSource } from './export'

const host = new JSDOM('')
beforeAll(() => { vi.stubGlobal('DOMParser', host.window.DOMParser); vi.stubGlobal('document', host.window.document) })
afterAll(() => { host.window.close(); vi.unstubAllGlobals() })
afterEach(() => vi.restoreAllMocks())
const svg = (content: string, attributes = 'width="200" height="100"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attributes}>${content}</svg>`
const stops = '<stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/>'
const rectangle = (gradient = 'g', extra = '') => `<rect id="shape" x="10" y="20" width="80" height="40" fill="url(#${gradient})" ${extra}/>`
function imported(source: string) {
  const result = importSvg(source)
  validateDocument(result.document)
  return result.document
}
const shape = (doc: DesignDocument) => Object.values(doc.nodes).find(n => n.name === 'shape')!
function render(doc: DesignDocument) {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    return engine.render_rgba(JSON.stringify({ pageId: doc.pages[0].id, width: 128, height: 96,
      view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' })).slice()
  } finally { engine.free() }
}

test('real XML importer converts absolute geometry/stroke units and retains editable vector topology', () => {
  const doc = imported(svg('<rect id="shape" x="1in" y="6pc" width="25.4mm" height="2.54cm" rx="3pt" fill="#AbC" stroke="#123456" stroke-width="1.5pt" stroke-dashoffset="-.5pc" stroke-dasharray="1.5pt, 2px 0.5pc"/><path fill="none" d="M0 0H10V10H0Z"/>', 'width="3in" height="2in"'))
  expect(doc.nodes[doc.pages[0].children[0]]).toMatchObject({ width: 288, height: 192 })
  expect(shape(doc)).toMatchObject({ width: 96, height: 96, transform: [1, 0, 0, 1, 96, 96], radii: [4, 4, 4, 4] })
  expect(shape(doc).fills[0].color).toBe('#aabbcc')
  expect(shape(doc).strokes[0]).toMatchObject({ width: 2, dashOffset: -8, dash: '2 2 8' })
  expect(Object.values(doc.nodes).find(n => n.kind === 'vector')!.network!.edges).toHaveLength(4)
})

test('rotation, root viewBox and use placement compose in the authored order', () => {
  const doc = imported(svg('<defs><rect id="shape" x="10" y="20" width="4" height="6" fill="#000000"/></defs><use href="#shape" x="5" y="7" transform="rotate(90,10,20)"/>', 'width="200" height="100" viewBox="0 0 100 50"'))
  const group = doc.nodes[doc.nodes[doc.pages[0].children[0]].children[0]]
  const p = apply(group.transform, apply(shape(doc).transform, { x: 0, y: 0 }))
  expect(p.x).toBeCloseTo(6, 12)
  expect(p.y).toBeCloseTo(50, 12)
})

test('gradient href chains inherit attributes/stops, ignore descriptions and respect inline stop precedence', () => {
  const doc = imported(svg(`<defs><linearGradient id="base" x2="50%"><stop offset="-10%" stop-color="#ff0000" style="stop-color: #123456"/><stop offset="75%" stop-color="#ffffff"/><stop offset="25%" stop-color="#abcdef"/><stop offset="200%" stop-color="#000000"/></linearGradient><linearGradient id="middle" xlink:href="#base" y2="50%"/><linearGradient id="g" href="#middle" x1="25%"><title>Inherited ramp</title></linearGradient></defs>${rectangle()}`))
  const p = shape(doc).fills[0]
  expect(p.stops).toEqual([{ offset: 0, color: '#123456' }, { offset: .75, color: '#ffffff' }, { offset: .75, color: '#abcdef' }, { offset: 1, color: '#000000' }])
  expect(p.transform).toEqual([.25, .5, -.5, .25, .25, 0])
})

test('href overrides xlink:href and child stop lists override inherited lists', () => {
  const doc = imported(svg(`<defs><linearGradient id="base">${stops}</linearGradient><linearGradient id="g" href="#base" xlink:href="#missing"><stop offset=".4" stop-color="#123456"/></linearGradient></defs>${rectangle()}`))
  expect(shape(doc).fills[0].stops).toEqual([{ offset: .4, color: '#123456' }, { offset: 1, color: '#123456' }])
})

test('user-space percentages/defaults use the viewBox dimensions, not fractions or viewport pixels', () => {
  const doc = imported(svg(`<defs><linearGradient id="g" gradientUnits="userSpaceOnUse">${stops}</linearGradient></defs>${rectangle()}`, 'width="400" height="200" viewBox="10 20 200 100"'))
  expect(shape(doc).fills[0].transform).toEqual([2.5, 0, 0, 5, -.125, -.5])
})

test('user-space radial percentages use the normalized viewport diagonal', () => {
  const doc = imported(svg(`<defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="25%" cy="50%" r="10%" fx="50" fy="50">${stops}</radialGradient></defs>${rectangle()}`))
  const matrix = shape(doc).fills[0].transform!, r = Math.sqrt((200 * 200 + 100 * 100) / 2) * .1
  expect(matrix[0]).toBeCloseTo(2 * r / 80, 14)
  expect(matrix[3]).toBeCloseTo(2 * r / 40, 14)
  expect(apply(matrix, { x: .5, y: .5 })).toEqual({ x: .5, y: .75 })
})

test('full affine gradient basis preserves shear and nonuniform user-space scaling at independent sample coordinates', () => {
  for (const user of [false, true]) {
    const source = svg(`<defs><linearGradient id="g" ${user ? 'gradientUnits="userSpaceOnUse" x1="10" y1="20" x2="50" y2="40"' : 'x1="0.125" y1="0.25" x2="0.625" y2="0.5"'} gradientTransform="matrix(2 .5 1 3 4 5)">${stops}</linearGradient></defs>${rectangle()}`)
    const doc = imported(source), matrix = shape(doc).fills[0].transform!
    const start = user ? [10, 20] : [.125, .25], delta = user ? [40, 20] : [.5, .25]
    for (const t of [0, .125, .5, 1]) for (const across of [-.5, 0, 1]) {
      // Independent SVG definition: points along a perpendicular in source
      // gradient coordinates retain the same stop parameter after affine map.
      const x = start[0] + delta[0] * t - delta[1] * across
      const y = start[1] + delta[1] * t + delta[0] * across
      const tx = 2 * x + y + 4, ty = .5 * x + 3 * y + 5
      const normalized = user ? { x: (tx - 10) / 80, y: (ty - 20) / 40 } : { x: tx, y: ty }
      expect(apply(inverse(matrix), normalized).x).toBeCloseTo(t, 12)
    }
  }
})

test('real CPU/WASM pixels and .fd round trips retain corrected gradient geometry, colors and editability', () => {
  const doc = imported(svg(`<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="20" x2="90" y2="60" gradientTransform="matrix(1 0 .5 1 0 0)">${stops}</linearGradient></defs>${rectangle()}`))
  const expected: Matrix = [1.25, 1, 0, 2, .125, 0]
  expect(shape(doc).fills[0].transform).toEqual(expected)
  const pixels = render(doc)
  expect(pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
  const decoded = validateDocument(decodeDocumentBinary(encodeDocumentBinary(doc)))
  expect(shape(decoded).fills).toEqual(shape(doc).fills)
  expect(shape(decoded).kind).toBe('rectangle')
  expect(render(decoded)).toEqual(pixels)
  // Meaningful negative control: former endpoint-only basis changes pixels.
  const broken = structuredClone(doc)
  shape(broken).fills[0].transform = [1.25, 1, -1, 1.25, .125, 0]
  expect(render(broken)).not.toEqual(pixels)
  const exported = svgSource(doc, doc.pages[0].id).source
  expect(exported).toContain('matrix(1.25 1 0 2 0.125 0)')
  expect(exported).not.toContain('<image')
})

test.each(['linearGradient', 'radialGradient'])('degenerate %s uses the last stop as required, with an editable solid paint', tag => {
  const attrs = tag === 'linearGradient' ? 'x1=".5" y1=".5" x2=".5" y2=".5"' : 'r="0"'
  const doc = imported(svg(`<defs><${tag} id="g" ${attrs}>${stops}</${tag}></defs>${rectangle()}`))
  expect(shape(doc).fills[0]).toMatchObject({ kind: 'solid', color: '#ffffff' })
})

test.each([
  ['self-cycle', '<linearGradient id="g" href="#g"/>', /循环/],
  ['mutual-cycle', '<linearGradient id="g" href="#b"/><linearGradient id="b" href="#g"/>', /循环/],
  ['external', '<linearGradient id="g" href="https://example.invalid/a.svg#b"/>', /外部/],
  ['missing', '<linearGradient id="g" href="#missing"/>', /缺少/],
  ['wrong-type', '<linearGradient id="g" href="#b"/><rect id="b"/>', /模板/],
  ['bad-units', `<linearGradient id="g" gradientUnits="bogus">${stops}</linearGradient>`, /坐标单位/],
  ['bad-stop', '<linearGradient id="g"><stop offset="NaN" stop-color="#000000"/></linearGradient>', /offset/],
  ['repeat', `<linearGradient id="g" spreadMethod="repeat">${stops}</linearGradient>`, /重复/],
  ['stop-alpha', '<linearGradient id="g"><stop style="stop-opacity: .5" stop-opacity="1" stop-color="#000000"/></linearGradient>', /透明度/],
  ['focal-radius', `<radialGradient id="g" fr=".1">${stops}</radialGradient>`, /焦点/],
  ['focal-position', `<radialGradient id="g" fx=".2">${stops}</radialGradient>`, /偏心/],
  ['color-space', `<linearGradient id="g" color-interpolation="linearRGB">${stops}</linearGradient>`, /color-interpolation/],
  ['animation', '<linearGradient id="g"><animate attributeName="x1"/></linearGradient>', /动态/],
  ['stop-limit', `<linearGradient id="g">${'<stop stop-color="#000000"/>'.repeat(65)}</linearGradient>`, /64/],
] as const)('gradient %s fails explicitly without partial output', (_name, defs, error) => {
  expect(() => importSvg(svg(`<defs>${defs}</defs>${rectangle()}`))).toThrow(error)
})

test('gradient reference depth accepts 64 and rejects 65 without recursion overflow', () => {
  const chain = (count: number) => Array.from({ length: count }, (_, i) => `<linearGradient id="g${i}" ${i + 1 < count ? `href="#g${i + 1}"` : ''}>${i === count - 1 ? stops : ''}</linearGradient>`).join('')
  expect(shape(imported(svg(`<defs>${chain(64)}</defs>${rectangle('g0')}`))).fills[0].stops).toHaveLength(2)
  expect(() => importSvg(svg(`<defs>${chain(65)}</defs>${rectangle('g0')}`))).toThrow(/64/)
})

test('native numeric errors reject before returning a document; existing safety/feature diagnostics remain explicit', () => {
  for (const content of [
    '<rect width="1e309" height="1"/>', '<rect width="-1" height="1"/>', '<rect width="1" height="1" opacity="NaN"/>',
    '<rect width="1" height="1" fill-opacity="0x0"/>', '<rect width="1" height="1" stroke="#000000" stroke-width="NaN"/>',
    '<g transform="translate()"><rect width="1" height="1"/></g>',
  ]) expect(() => importSvg(svg(content))).toThrow(/SVG/)
  for (const content of ['<script/>', '<style/>', '<foreignObject/>', '<svg/>', '<rect onclick="x()"/>', '<rect filter="url(#blur)"/>', '<use href="https://example.invalid/a.svg#x"/>', '<text><tspan>unsupported</tspan></text>'])
    expect(() => importSvg(svg(content))).toThrow(/SVG/)
  expect(() => importSvg('<!DOCTYPE svg><svg/>')).toThrow(/声明/)
  expect(() => importSvg(' '.repeat(16 * 1024 * 1024 + 1))).toThrow(/大小/)
  expect(() => importSvg(svg('<use id="cycle" href="#cycle"/>'))).toThrow(/层级/)
  expect(imported(svg('<rect id="shape" width="1" height="1" filter="none" fill="#000000"/>'))).toBeDefined()
})

test('repeated opaque hexadecimal paints require no canvas and keep independent editable paint objects', () => {
  const create = vi.spyOn(document, 'createElement')
  const doc = imported(svg('<rect width="1" height="1" fill="#ABC"/>'.repeat(1024)))
  expect(create.mock.calls.filter(([tag]) => tag === 'canvas')).toHaveLength(0)
  const paints = Object.values(doc.nodes).filter(n => n.kind === 'rectangle').map(n => n.fills[0])
  expect(new Set(paints.map(p => p.id)).size).toBe(1024)
  expect(new Set(paints.map(p => p.color))).toEqual(new Set(['#aabbcc']))
})

test('gradient caches never alias editable stop arrays or per-node coordinate transforms', () => {
  const doc = imported(svg(`<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x2="80">${stops}</linearGradient></defs>${rectangle()}<rect id="other" width="40" height="20" fill="url(#g)"/>`))
  const first = shape(doc).fills[0], other = Object.values(doc.nodes).find(n => n.name === 'other')!.fills[0]
  expect(first.stops).not.toBe(other.stops)
  expect(first.stops[0]).not.toBe(other.stops[0])
  expect(first.transform).not.toEqual(other.transform)
  first.stops[0].color = '#ff0000'
  expect(other.stops[0].color).toBe('#000000')
})

test('inherited unsupported gradient color interpolation is diagnosed and explicit sRGB can override it', () => {
  const defs = `<defs><linearGradient id="g">${stops}</linearGradient></defs>${rectangle()}`
  expect(() => importSvg(svg(defs, 'width="200" height="100" color-interpolation="linearRGB"'))).toThrow(/color-interpolation/)
  expect(() => imported(svg(defs.replace('id="g"', 'id="g" color-interpolation="sRGB"'), 'width="200" height="100" color-interpolation="linearRGB"'))).not.toThrow()
})

test('absolute dimensions, path topology and corrected transforms survive native persistence', () => {
  const doc = imported(svg('<path id="shape" fill="#123456" transform="rotate(90 10 20)" d="M0 0C1 2 3 4 10 10L20 20H0Z"/>'))
  const decoded = validateDocument(decodeDocumentBinary(encodeDocumentBinary(doc)))
  expect(shape(decoded).network).toEqual(shape(doc).network)
  expect(shape(decoded).transform).toEqual(shape(doc).transform)
  expect(render(decoded)).toEqual(render(doc))
})

test('unsupported CSS transforms are explicit, and CSS transform:none overrides the presentation attribute', () => {
  for (const attribute of ['style="transform: translate(10px, 20px)"', 'style="transform-origin: center"', 'transform-origin="10 20"'])
    expect(() => importSvg(svg(`<rect id="shape" width="10" height="20" ${attribute}/>`))).toThrow(/transform/)
  const doc = imported(svg('<rect id="shape" width="10" height="20" fill="#000000" transform="translate(99 99)" style="transform:none"/>'))
  expect(shape(doc).transform).toEqual([1, 0, 0, 1, 0, 0])
})

test('unsupported, nonfinite and negative dash lengths never become invalid native stroke data', () => {
  for (const dash of ['1,,2', '1,', ',1', '-1 2', '1e309', '1%', '1em', '1e-7', '10000001'])
    expect(() => importSvg(svg(`<rect width="10" height="20" fill="none" stroke="#000000" stroke-dasharray="${dash}"/>`))).toThrow(/stroke-dasharray/)
})
