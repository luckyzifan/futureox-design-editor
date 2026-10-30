import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { svgPaintValue, svgPresentation, svgRootPresentation } from './svg-presentation.ts'

// Attribute-only parser fixtures. No DOM implementation, canvas, renderer,
// WASM setup, browser, or GPU module is imported or simulated.
const element = (attributes = {}) => ({ getAttribute: name => attributes[name] ?? null })

test('root fill none and stroke inherit into otherwise unstyled geometry', () => {
  const root = svgRootPresentation(element({ fill: 'none', stroke: '#ff0000', 'stroke-width': '3' }))
  const rectangle = svgPresentation(element(), root.style)
  assert.equal(rectangle.style.fill, 'none')
  assert.equal(rectangle.style.stroke, '#ff0000')
  assert.equal(rectangle.style['stroke-width'], '3')
})

test('inline root styles take precedence and descendant presentation can override them', () => {
  const root = svgRootPresentation(element({ fill: '#ffffff', style: 'fill: none; stroke: #ff0000; font-size: 24; font-family: Example; font-weight: 700' }))
  const child = svgPresentation(element({ fill: '#00ff00', stroke: '#000000', style: 'stroke: #0000ff' }), root.style)
  assert.equal(root.style.fill, 'none')
  assert.equal(child.style.fill, '#00ff00')
  assert.equal(child.style.stroke, '#0000ff')
  assert.equal(child.style['font-size'], '24')
  assert.equal(child.style['font-family'], 'Example')
  assert.equal(child.style['font-weight'], '700')
})

test('currentColor remains inherited until the painted child resolves its own color', () => {
  const root = svgRootPresentation(element({ fill: 'currentColor', stroke: 'currentColor', color: '#ff0000' }))
  const child = svgPresentation(element({ color: '#0000ff', fill: 'inherit' }), root.style)
  assert.equal(svgPaintValue(root.style.stroke, root.style), '#ff0000')
  assert.equal(svgPaintValue(child.style.fill, child.style), '#0000ff')
  assert.equal(svgPaintValue(child.style.stroke, child.style), '#0000ff')
})

test('root opacity belongs once to the containing frame rather than each overlapping child', () => {
  const root = svgRootPresentation(element({ opacity: '.5' }))
  const first = svgPresentation(element(), root.style)
  const overlapping = svgPresentation(element({ opacity: '.8' }), root.style)
  assert.equal(root.opacity, .5)
  assert.equal(first.opacity, 1)
  assert.equal(overlapping.opacity, .8)
  assert.equal(root.style.opacity, undefined)
  const source = readFileSync(new URL('./import-svg.ts', import.meta.url), 'utf8')
  assert.match(source, /frame\.opacity = rootPresentation\.opacity/)
  assert.match(source, /n\.opacity = opacity/)
  assert.doesNotMatch(source, /n\.opacity\s*=.*rootPresentation/)
})

test('visibility inherits while an explicit child override remains possible', () => {
  const root = svgRootPresentation(element({ visibility: 'hidden' }))
  assert.equal(svgPresentation(element(), root.style).style.visibility, 'hidden')
  assert.equal(svgPresentation(element({ visibility: 'visible' }), root.style).style.visibility, 'visible')
  assert.equal(root.display, '')
  assert.equal(svgRootPresentation(element({ style: 'display: none' })).display, 'none')
  const source = readFileSync(new URL('./import-svg.ts', import.meta.url), 'utf8')
  assert.match(source, /frame\.visible = rootPresentation\.display !== 'none'/)
  assert.match(source, /tag === 'g' \|\| tag === 'svg' \|\| !\['hidden', 'collapse'\]\.includes\(style\.visibility\)/)
})

test('unsupported root transforms and compositing are explicit errors, not silent changes', () => {
  for (const attributes of [
    { transform: 'translate(5 10)' }, { style: 'transform: scale(2)' },
    { filter: 'url(#blur)' }, { mask: 'url(#mask)' }, { 'clip-path': 'url(#clip)' },
    { style: 'mix-blend-mode: multiply' },
  ]) assert.throws(() => svgRootPresentation(element(attributes)), /原文件未修改/)
  for (const opacity of ['NaN', 'Infinity', '-1', '2']) {
    assert.throws(() => svgRootPresentation(element({ opacity })), /opacity/)
  }
  assert.equal(svgRootPresentation(element({ opacity: '0', style: 'filter: none; mix-blend-mode: normal' })).opacity, 0)
})

test('root and descendants share presentation parsing without changing viewport mapping', () => {
  const source = readFileSync(new URL('./import-svg.ts', import.meta.url), 'utf8')
  assert.match(source, /const rootPresentation = svgRootPresentation\(root\)/)
  assert.match(source, /const \{ style, inline, opacity, display \} = svgPresentation\(el, inherited\)/)
  assert.match(source, /visit\(e, frame\.children, rootPresentation\.style\)/)
  assert.match(source, /svgViewportTransform\(vb, frame\.width, frame\.height, root\.getAttribute\('preserveAspectRatio'\)\)/)
  assert.match(source, /doc\.nodes\[id\]\.transform = multiply\(m, doc\.nodes\[id\]\.transform\)/)
})
