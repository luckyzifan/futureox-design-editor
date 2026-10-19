import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { transformWithOxc } from 'vite'
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime'
import { Scene } from './Renderer'
import * as geometry from './geometry'
import { blank, node, paint, effect, maskChild, container, type Matrix, type DesignDocument } from './model'
import { KernelClient } from './kernel/client'
import * as picking from './kernel/picking'
import * as compatibility from './export'
import { pdfVectorIssues, sliceExportTarget, type ExportTarget } from './export-metadata'
import { figmaFixture, type ReferenceCase } from './figma-fixtures'
import { deepScene } from './stress-fixtures'

// Compile and execute the actual frozen module, substituting only its import
// bindings with the same live dependencies used by the current export module.
// This retains the original React serializer and complete SVG strings.
const frozen = readFileSync(new URL('../../../testing/verification-optional-startup/export.before.tsx', import.meta.url), 'utf8')
const sourceHash = '0d3804590084e0b43e486a23ed1876455e1f1788ff8624f3cfbb75559a4f83de'
async function baseline(source = frozen) {
  const compiled = (await transformWithOxc(source, 'export.before.tsx', { jsx: { runtime: 'automatic' } })).code
  const imports = compiled.match(/^import .*;\n/gm) ?? []
  expect(imports).toHaveLength(7)
  const body = compiled.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
  expect(body).not.toMatch(/^import |^export /m)
  const scope = { renderToStaticMarkup, _jsx, _jsxs, Scene, ...geometry, pointBounds: geometry.bounds, maskChild, container, KernelClient, ...picking }
  return new Function(...Object.keys(scope), `"use strict";\n${body}\nreturn { sliceExportTarget, pdfVectorIssues, svgSource, targetBounds, exportBounds, filename, svgExportIssues }`)(...Object.values(scope)) as Pick<typeof compatibility, 'sliceExportTarget' | 'pdfVectorIssues' | 'svgSource' | 'targetBounds' | 'exportBounds' | 'filename' | 'svgExportIssues'>
}
const old = await baseline()
function capture<T>(call: () => T) {
  try { return { value: call() } }
  catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message } } }
}
function compareMetadata(doc: DesignDocument, target: ExportTarget = { kind: 'page' }) {
  const before = JSON.stringify(doc)
  const current = capture(() => pdfVectorIssues(doc, doc.pages[0].id, target))
  expect(current).toStrictEqual(capture(() => old.pdfVectorIssues(doc, doc.pages[0].id, target)))
  expect(JSON.stringify(doc)).toBe(before)
  return current
}
function compareSvg(doc: DesignDocument, target: ExportTarget = { kind: 'page' }, scale = 1) {
  const before = JSON.stringify(doc)
  const current = capture(() => compatibility.svgSource(doc, doc.pages[0].id, target, scale))
  // No rounding, normalization, XML canonicalization or digest-only comparison.
  expect(current).toStrictEqual(capture(() => old.svgSource(doc, doc.pages[0].id, target, scale)))
  expect(JSON.stringify(doc)).toBe(before)
  return current
}

test('retained baseline is hash-verified and extraction leaves every other export function byte-identical', () => {
  expect(createHash('sha256').update(frozen).digest('hex')).toBe(sourceHash)
  const targets = frozen.slice(frozen.indexOf('export type ExportTarget ='), frozen.indexOf('function projectSlice('))
  const pdf = frozen.slice(frozen.indexOf('/** Content the true-vector PDF writer'), frozen.indexOf('/** Explicit visual exchange mode.'))
  const metadata = readFileSync(new URL('./export-metadata.ts', import.meta.url), 'utf8')
  expect(metadata.slice(metadata.indexOf('export type ExportTarget ='))).toBe(targets + pdf)
  const current = readFileSync(new URL('./export.tsx', import.meta.url), 'utf8')
  expect(current.slice(current.indexOf('function projectSlice('))).toBe(frozen.slice(frozen.indexOf('function projectSlice(')).replace(pdf, ''))
})

test('the existing public API keeps the exact same synchronous metadata function objects', () => {
  expect(compatibility.pdfVectorIssues).toBe(pdfVectorIssues)
  expect(compatibility.sliceExportTarget).toBe(sliceExportTarget)
  expect(pdfVectorIssues(blank(), 'missing')).not.toBeInstanceOf(Promise)
  const doc = blank(), slice = node('slice', 1, 2, 3, 4)
  doc.nodes[slice.id] = slice; doc.pages[0].children = [slice.id]
  expect(sliceExportTarget(doc, slice.id)).not.toBeInstanceOf(Promise)
})

const cases: ReferenceCase[] = ['rectangle', 'curve', 'rotated-curve', 'alpha-curve', 'shadow', 'layer-blur', 'blur-radii', 'coverage-overlap', 'group-blur', 'group-shadow', 'group-inner-shadow', 'backdrop-blur', 'pass-through', 'pass-through-opacity', 'isolated-opacity', 'pass-through-blur', 'mask-half-overlap', 'mask-overlap', 'mask-outside']
test.each(cases)('complete SVG bytes and metadata remain exact for %s', kind => {
  const doc = figmaFixture(kind)
  compareMetadata(doc)
  expect(compareSvg(doc).value).toBeDefined()
  for (const root of doc.pages[0].children.slice(0, 2)) {
    const target = { kind: 'selection' as const, nodeIds: [root] }
    compareMetadata(doc, target)
    expect(compareSvg(doc, target, 2).value).toBeDefined()
  }
})

test('nested groups, escaped title text, outlines and fractional slice output preserve exact SVG bytes', () => {
  const doc = deepScene(12)
  doc.name = '设计 <SVG> & "names" 😀'
  const text = node('text', -1.125, 2.875, 180, 40)
  text.text = 'Hello 世界 & SVG'; text.fontSize = 22
  doc.nodes[text.id] = text; doc.pages[0].children.push(text.id)
  expect(compareSvg(doc).value).toBeDefined()
  expect(compareSvg(doc, { kind: 'slice', bounds: { x: -.125, y: .375, width: 53.25, height: 42.875 } }, 2.5).value).toBeDefined()
  for (const scale of [NaN, 0, 129]) expect(compareSvg(doc, { kind: 'page' }, scale).error).toBeDefined()
})

test('rotated, reflected, skewed, nested and singular slices retain floats and exact error behavior', () => {
  const transforms: Matrix[] = [[1, 0, 0, 1, .125, -.5], [2, 0, 0, 3, 100, 80], [0, 2, -3, 0, 100, 80], [-2, 0, 0, 3, -4, 6], [1.25, -.75, 2.125, 3.875, .125, -.375], [0, 0, 0, 1, 2, 3]]
  for (const transform of transforms) {
    const doc = blank(), group = node('group', 13.5, -9.25, 200, 200), slice = node('slice', 0, 0, 80.125, 50.375), shape = node('rectangle', 4, 5, 70, 50)
    slice.transform = transform; group.children = [slice.id, shape.id]
    doc.nodes = { [group.id]: group, [slice.id]: slice, [shape.id]: shape }; doc.pages[0].children = [group.id]
    const before = JSON.stringify(doc)
    for (const id of [slice.id, group.id, 'missing']) {
      const current = capture(() => sliceExportTarget(doc, id))
      expect(current).toStrictEqual(capture(() => old.sliceExportTarget(doc, id)))
      if (current.value) expect(compareSvg(doc, current.value).value).toBeDefined()
    }
    expect(JSON.stringify(doc)).toBe(before)
  }
})

test('PDF issue ordering, selected subtrees, masks, hidden content and repeat effects are unchanged', () => {
  const doc = blank(), group = node('frame', 0, 0, 40, 40), mask = node('rectangle'), child = node('rectangle'), sibling = node('ellipse')
  group.effects = [effect('shadow')]; mask.mask = true
  const angular = paint('#aabbcc'); angular.kind = 'angular'; child.fills = [angular]
  const diamond = paint('#112233'); diamond.kind = 'diamond'; sibling.fills = [diamond]
  group.children = [mask.id, child.id]
  doc.nodes = Object.fromEntries([group, mask, child, sibling].map(n => [n.id, n])); doc.pages[0].children = [group.id, sibling.id]
  expect(compareMetadata(doc).value).toStrictEqual(['滤镜效果', '蒙版', '角向/菱形渐变'])
  for (const ids of [[group.id], [child.id], [sibling.id], [], ['missing']]) compareMetadata(doc, { kind: 'selection', nodeIds: ids })
  for (const n of [group, mask, child, sibling]) { n.visible = false; compareMetadata(doc); n.visible = true; n.opacity = 0; compareMetadata(doc) }
})

test('mutation controls detect changed metadata and complete SVG serializer output', async () => {
  const changed = await baseline(frozen.replace('width:n.width*sx', 'width:n.width*sx+1').replaceAll('<title>{doc.name}</title>', '<title>{doc.name + " changed"}</title>').replaceAll("issues.add('滤镜效果')", "issues.add('CHANGED')"))
  const doc = figmaFixture('shadow'), slice = node('slice', 0, 0, 10, 20)
  doc.nodes[slice.id] = slice; doc.pages[0].children.push(slice.id)
  expect(changed.sliceExportTarget(doc, slice.id)).not.toStrictEqual(sliceExportTarget(doc, slice.id))
  expect(changed.pdfVectorIssues(doc, doc.pages[0].id)).not.toStrictEqual(pdfVectorIssues(doc, doc.pages[0].id))
  expect(changed.svgSource(doc, doc.pages[0].id).source).not.toBe(compatibility.svgSource(doc, doc.pages[0].id).source)
})
