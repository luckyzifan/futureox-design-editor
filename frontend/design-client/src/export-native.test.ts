import { beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking, kernelSvgPaths } from './kernel/picking'
import { blank, node } from './model'
import { svgSource, exportBounds, svgExportIssues } from './export'
import { figmaFixture } from './figma-fixtures'
import { copiedScene, deepScene } from './stress-fixtures'
beforeAll(async () =>
  initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  }),
)
test('SVG ellipse export retains exact arc geometry at every display scale', () => {
  const doc = blank(),
    n = node('ellipse', 0, 0, 64, 48)
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  const paths = kernelSvgPaths(n)!
  expect(paths.fill.match(/A/g)).toHaveLength(2)
  expect(paths.fill).toContain('A32 24')
  expect(paths.fill).not.toContain('L')
  expect(svgSource(doc, doc.pages[0].id).source).toContain(paths.fill)
})
test('SVG text uses the same Rust font outlines without relying on a viewer font', () => {
  const doc = blank(),
    n = node('text', 0, 0, 240, 60)
  n.text = '核心 SVG'
  n.fontSize = 24
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  const source = svgSource(doc, doc.pages[0].id).source
  expect(source).not.toContain('<text')
  expect(kernelSvgPaths(n)!.fill.length).toBeGreaterThan(100)
  expect(source).toContain(kernelSvgPaths(n)!.fill)
})
test('unwrapped text ink outside its logical box remains inside export bounds', () => {
  const doc = blank(),
    n = node('text', 0, 0, 10, 20)
  n.text = 'Hello Forma '.repeat(8)
  n.fontSize = 20
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  expect(exportBounds(doc, doc.pages[0].id).width).toBeGreaterThan(500)
})
test('copied deep SVG scenes keep definitions local and every reference resolves', () => {
  const original = deepScene(),
    doc = copiedScene(original),
    source = svgSource(doc, doc.pages[0].id).source
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
    known = new Set(ids)
  expect(known.size).toBe(ids.length)
  for (const match of source.matchAll(/(?:href="#|url\(#)([^"\)]+)/g))
    expect(known.has(match[1])).toBe(true)
  for (const id of Object.keys(original.nodes)) expect(source).not.toContain(id)
})
test('offscreen mask geometry does not enlarge a clipped frame export', () => {
  for (const kind of ['mask-overlap', 'mask-outside'] as const) {
    const doc = figmaFixture(kind),
      box = exportBounds(doc, doc.pages[0].id)
    expect(box).toEqual({ x: -40, y: -40, width: 208, height: 208 })
    expect(svgExportIssues(doc, doc.pages[0].id)).toEqual([])
  }
})
test('SVG capability reporting rejects effects and non-isolated translucent groups explicitly', () => {
  const doc = blank(),
    g = node('group', 0, 0, 100, 100),
    r = node('rectangle', 0, 0, 30, 30)
  g.blend = 'pass-through'
  g.opacity = 0.5
  g.children = [r.id]
  doc.nodes[g.id] = g
  doc.nodes[r.id] = r
  doc.pages[0].children = [g.id]
  expect(svgExportIssues(doc, doc.pages[0].id)).toContain('带透明度或蒙版的穿透组')
})
