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

test('retained baseline is hash-verified and only declared repeat, SVG option and font-def changes alter export bodies', () => {
  expect(createHash('sha256').update(frozen).digest('hex')).toBe(sourceHash)
  const targets = frozen.slice(frozen.indexOf('export type ExportTarget ='), frozen.indexOf('function projectSlice('))
  const pdf = frozen.slice(frozen.indexOf('/** Content the true-vector PDF writer'), frozen.indexOf('/** Explicit visual exchange mode.'))
  const metadata = readFileSync(new URL('./export-metadata.ts', import.meta.url), 'utf8')
  expect(metadata.slice(metadata.indexOf('export type ExportTarget ='))).toBe(targets + pdf)
  const current = readFileSync(new URL('./export.tsx', import.meta.url), 'utf8')
  // Keep the immutable baseline and enumerate exact approved feature deltas.
  // Ordinary SVG bytes and mutation controls remain independently checked below;
  // repeat-transforms and svg-artifact suites exercise the new visual behavior.
  const retained = frozen.slice(frozen.indexOf('function projectSlice(')).replace(pdf, '')
  const deltas: [string, string][] = [
    [
        "/** Page presentation retains its explicit historical 40-unit margin. */\nexport function exportBounds(doc: DesignDocument, pageId: string, padding = 40) {\n  if (!Number.isFinite(padding) || padding < 0 || padding > 1e6)\n    throw new Error('页面留白必须为 0–1000000')\n",
        "/** Page presentation retains its explicit historical 40-unit margin. */\nexport function exportBounds(doc: DesignDocument, pageId: string, padding = 40) {\n  doc = sketchMaskScene(expandRepeats(doc))\n  if (!Number.isFinite(padding) || padding < 0 || padding > 1e6)\n    throw new Error('页面留白必须为 0–1000000')\n"
    ],
    [
        "  }\n  const ids = new Set(target.nodeIds)\n  const entries = scene(doc, pageId).filter((entry) => ids.has(entry.id))\n  if (!ids.size || ids.size > 1000 || entries.length !== ids.size)\n    throw new Error('请选择当前页面的 1–1000 个可见图层')\n  return unionBounds(\n    entries\n      .filter((entry) => !entry.ancestors.some((id) => ids.has(id)))\n      .map((entry) => {\n        const n=doc.nodes[entry.id]\n",
        "  }\n  const ids = new Set(target.nodeIds)\n  doc = expandRepeats(doc)\n  const entries = scene(doc, pageId).filter((entry) => ids.has(repeatSourceId(doc, entry.id)))\n  if (!ids.size || ids.size > 1000 || new Set(entries.map(e=>repeatSourceId(doc,e.id))).size !== ids.size)\n    throw new Error('请选择当前页面的 1–1000 个可见图层')\n  return unionBounds(\n    entries\n      .filter((entry) => !entry.ancestors.some((id) => ids.has(repeatSourceId(doc,id))))\n      .map((entry) => {\n        const n=doc.nodes[entry.id]\n"
    ],
    [
        "  return { name: `${doc.name}-visual.svg`, blob: new Blob([source], { type: 'image/svg+xml' }) }\n}\nexport function svgSource(doc: DesignDocument, pageId: string, target: ExportTarget = {kind:'page'}, scale = 1) {\n  doc = projectSlice(kernelLayout(doc),pageId,target)\n  const b = targetBounds(doc, pageId, target)\n  if(!Number.isFinite(scale) || scale<0.001 || scale>128) throw new Error('导出倍率必须在 0.001–128 之间')\n",
        "  return { name: `${doc.name}-visual.svg`, blob: new Blob([source], { type: 'image/svg+xml' }) }\n}\nexport function svgSource(doc: DesignDocument, pageId: string, target: ExportTarget = {kind:'page'}, scale = 1, precision?: number, textMode: 'outlines' | 'editable' = 'outlines', fontMode: 'references' | 'embed' = 'references', fontEmbeddingAllowed = false, fontByteLimit = 4 * 1024 * 1024, embeddedFonts?: DesignDocument['fonts']) {\n  if (fontMode === 'embed' && (textMode !== 'editable' || !fontEmbeddingAllowed)) throw new Error('Explicit editable font redistribution permission is required')\n  ;({doc,target} = repeatExport(kernelLayout(doc),target))\n  doc = projectSlice(doc,pageId,target)\n  const b = targetBounds(doc, pageId, target)\n  if(!Number.isFinite(scale) || scale<0.001 || scale>128) throw new Error('导出倍率必须在 0.001–128 之间')\n"
    ],
    [
        "    >\n      <title>{doc.name}</title>\n      <Scene doc={doc} pageId={pageId} exporting />\n    </svg>,\n  )\n  return { source, box: b, issues: svgExportIssues(doc, pageId) }\n}\n/** True-vector PDF: paths, axial/radial gradients, image fills and text\n",
        "    >\n      <title>{doc.name}</title>\n      {fontMode === 'embed' && <defs>{svgEmbeddedFonts(embeddedFonts ?? doc.fonts, new Set(scene(doc,pageId).filter(e=>doc.nodes[e.id].kind === 'text').flatMap(e=>['default', doc.nodes[e.id].textStyle?.fontId || 'default', ...(doc.nodes[e.id].textStyle?.fallbacks || []), ...(doc.nodes[e.id].textRuns || []).map(r=>r.fontId || doc.nodes[e.id].textStyle?.fontId || 'default')])), fontByteLimit).map(font => <style key={font.id} data-svg-font=\"1\" data-font-id={font.id} data-font-family={font.family}>{font.css}</style>)}</defs>}\n      <Scene doc={doc} pageId={pageId} exporting textMode={textMode} />\n    </svg>,\n  )\n  return { source: roundSvgCoordinates(source, precision), box: b, issues: svgExportIssues(doc, pageId) }\n}\n/** True-vector PDF: paths, axial/radial gradients, image fills and text\n"
    ],
    [
        "  await initializePicking()\n  if (signal?.aborted) throw new Error('已取消导出')\n  doc = projectSlice(kernelLayout(doc), pageId, target)\n  if (pdfVectorIssues(doc, pageId, target).length) {\n    const bitmap = (await exportRasterBatch(doc, pageId, [1], target, undefined, signal, 'pdf'))[0]\n",
        "  await initializePicking()\n  if (signal?.aborted) throw new Error('已取消导出')\n  const repeatedVisual = hasRepeats(doc)\n  ;({doc,target} = repeatExport(kernelLayout(doc),target))\n  doc = projectSlice(doc, pageId, target)\n  if (pdfVectorIssues(doc, pageId, target).length) {\n    const bitmap = (await exportRasterBatch(doc, pageId, [1], target, undefined, signal, 'pdf'))[0]\n"
    ],
    [
        "      transform: multiply(translate(-box.x, -box.y), entry.matrix),\n    }\n  const bytes = kernelPdfVector(shifted, pageId, width, height, true)\n  return {\n",
        "      transform: multiply(translate(-box.x, -box.y), entry.matrix),\n    }\n  closeVectorExportSnapshot(shifted, repeatedVisual)\n  const bytes = kernelPdfVector(shifted, pageId, width, height, true)\n  return {\n"
    ],
    [
        "  await initializePicking()\n  if (signal?.aborted) throw new Error('已取消导出')\n  doc = projectSlice(kernelLayout(doc),pageId,target)\n  const box = targetBounds(doc, pageId, target)\n  const plans = scales.map((scale) => {\n",
        "  await initializePicking()\n  if (signal?.aborted) throw new Error('已取消导出')\n  ;({doc,target} = repeatExport(kernelLayout(doc),target))\n  doc = projectSlice(doc,pageId,target)\n  const box = targetBounds(doc, pageId, target)\n  const plans = scales.map((scale) => {\n"
    ]
]
  deltas.push([
    "    for(const entry of roots) doc.nodes[entry.id]={...doc.nodes[entry.id],transform:[...entry.matrix]}\n  }\n  const source = renderToStaticMarkup(\n",
    "    for(const entry of roots) doc.nodes[entry.id]={...doc.nodes[entry.id],transform:[...entry.matrix]}\n  }\n  if (scene(doc,pageId).some(entry=>doc.nodes[entry.id].effects.some(e=>e.visible&&['motion-blur','zoom-blur'].includes(e.kind)))) throw new Error('运动模糊或缩放模糊需要保留视觉效果的 SVG 或位图导出')\n" +
    "  if (scene(doc,pageId).some(entry => doc.nodes[entry.id].effects.some(e => e.visible && e.colorControls?.space === 'display-p3'))) throw new Error('Display-P3 编码域颜色调整需要保留视觉效果的 SVG 或位图导出')\n" +
    "  const source = renderToStaticMarkup(\n",
  ])
  deltas.push([
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb') throw new Error('JPEG/WebP/PDF 当前使用 sRGB；广色域请导出 PNG')\n",
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb' && colorOutput.space !== 'display-p3') throw new Error('JPEG、WebP 与 PDF 只标记 sRGB 或 Display P3；其他色彩空间请导出 PNG')\n",
  ])
  deltas.push([
    "  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector',\n",
    "  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector' | 'tiff',\n",
  ])
  deltas.push([
    "  if (!['png','svg','jpeg','webp','pdf','pdf-vector'].includes(format)) throw new Error(`不支持的导出格式 ${String(format)}`)\n",
    "  if (!['png','svg','jpeg','webp','pdf','pdf-vector','tiff'].includes(format)) throw new Error(`不支持的导出格式 ${String(format)}`)\n",
  ])
  deltas.push([
    "  format: 'png' | 'jpeg' | 'webp' | 'pdf' = 'png',\n",
    "  format: 'png' | 'jpeg' | 'webp' | 'pdf' | 'tiff' = 'png',\n",
  ])
  deltas.push([
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb' && colorOutput.space !== 'display-p3') throw new Error('JPEG、WebP 与 PDF 只标记 sRGB 或 Display P3；其他色彩空间请导出 PNG')\n",
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb' && colorOutput.space !== 'display-p3') throw new Error('JPEG、WebP、TIFF 与 PDF 只标记 sRGB 或 Display P3；其他色彩空间请导出 PNG')\n",
  ])
  deltas.push([
    "  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector' | 'tiff',\n",
    "  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector' | 'tiff' | 'heic',\n",
  ])
  deltas.push([
    "  if (!['png','svg','jpeg','webp','pdf','pdf-vector','tiff'].includes(format)) throw new Error(`不支持的导出格式 ${String(format)}`)\n",
    "  if (!['png','svg','jpeg','webp','pdf','pdf-vector','tiff','heic'].includes(format)) throw new Error(`不支持的导出格式 ${String(format)}`)\n",
  ])
  deltas.push([
    "  format: 'png' | 'jpeg' | 'webp' | 'pdf' | 'tiff' = 'png',\n",
    "  format: 'png' | 'jpeg' | 'webp' | 'pdf' | 'tiff' | 'heic' = 'png',\n",
  ])
  deltas.push([
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb' && colorOutput.space !== 'display-p3') throw new Error('JPEG、WebP、TIFF 与 PDF 只标记 sRGB 或 Display P3；其他色彩空间请导出 PNG')\n",
    "  if (format !== 'png' && colorOutput && colorOutput.space !== 'srgb' && colorOutput.space !== 'display-p3') throw new Error('JPEG、WebP、TIFF、HEIC 与 PDF 只标记 sRGB 或 Display P3；其他色彩空间请导出 PNG')\n",
  ])
  let approved = retained
  for (const [before, after] of deltas) {
    expect(approved.split(before)).toHaveLength(2)
    approved = approved.replace(before, after)
  }
  expect(current.slice(current.indexOf('function projectSlice('))).toBe(approved)
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

test('SVG font defs require explicit editable redistribution consent and preserve exact supplied bytes', () => {
  const doc = blank(), text = node('text', 0, 0, 120, 40)
  text.text = 'AAA'
  doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
  const bytes = readFileSync(new URL('../../../design-studio/crates/design-kernel/tests/fixtures/sketch-fonts/font-0.ttf', import.meta.url))
  const data = bytes.toString('base64'), fonts = { default: { family: 'Core Test Narrow', data, index: 0 } }
  const before = JSON.stringify(doc), page = doc.pages[0].id
  expect(compatibility.svgSource(doc, page).source).not.toContain('data-svg-font')
  expect(() => compatibility.svgSource(doc, page, { kind: 'page' }, 1, undefined, 'editable', 'embed')).toThrow(/redistribution permission/)
  expect(() => compatibility.svgSource(doc, page, { kind: 'page' }, 1, undefined, 'outlines', 'embed', true)).toThrow(/redistribution permission/)
  const output = compatibility.svgSource(doc, page, { kind: 'page' }, 1, undefined, 'editable', 'embed', true, bytes.length, fonts).source
  expect(output).toContain('<defs><style data-svg-font="1"')
  expect(output).toContain(`data:font/ttf;base64,${data}`)
  expect(output).toContain('>AAA</tspan>')
  expect(() => compatibility.svgSource(doc, page, { kind: 'page' }, 1, undefined, 'editable', 'embed', true, bytes.length - 1, fonts)).toThrow(/budget/)
  expect(JSON.stringify(doc)).toBe(before)
})
