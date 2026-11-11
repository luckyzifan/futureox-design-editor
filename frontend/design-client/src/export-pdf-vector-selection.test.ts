import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { afterEach, expect, test, vi } from 'vitest'
import { createClip } from './animation'
import { defaultColorSettings } from './color'
import { insertInstance, stampKeys } from './components'
import { Editor } from './engine'
import { exportImage, exportPdfVector, targetBounds, type ExportTarget } from './export'
import { layerExportColorOutput } from './export-metadata'
import { kernelLayout } from './kernel/picking'
import type { KernelOptions } from './kernel/client'
import { VectorEngine, transcode_export_png } from './generated/design-kernel/design_kernel'
import {
  blank,
  defaultLayout,
  effect,
  node,
  paint,
  uid,
  validateDocument,
  type DesignDocument,
  type DesignNode,
} from './model'

const fontBytes = new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
/** Node has no browser Worker. This is the same product-export harness used by
 * the raster suites: KernelClient still drives exportImage, and the bytes come
 * from the real WASM CPU renderer and transcoder. */
class ExportCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor() {
    this.engine.load_font(fontBytes)
  }
  postMessage(request: { id: number; document?: string; options: KernelOptions; png?: boolean }) {
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const region = request.options.exportRegion
        if (!region) throw new Error('export test worker only serves export regions')
        let bytes = this.engine.render_region_png(JSON.stringify({
          pageId: request.options.pageId,
          ...region,
          rasterProfile: request.options.rasterProfile,
          colorOutput: request.options.colorOutput,
        }))
        if (request.options.exportFormat) bytes = transcode_export_png(bytes, request.options.exportFormat, region.scale)
        const copy = bytes.slice()
        this.onmessage?.({ data: { id: request.id, buffer: copy.buffer, stats: JSON.parse(this.engine.stats()), backend: 'cpu' } })
      } catch (error) {
        this.onmessage?.({ data: { id: request.id, error: String(error) } })
      }
    })
  }
  terminate() {
    if (!this.terminated) {
      this.terminated = true
      this.engine.free()
    }
  }
}
afterEach(() => vi.unstubAllGlobals())
function installExportWorker() {
  vi.stubGlobal('Worker', ExportCpuWorker)
}

const red = '#e11d48'
const blue = '#2563eb'
const green = '#16a34a'
const purple = '#a855f7'
const shadow = '#172033'

function pdfChannel(byte: number) {
  let token = (byte / 255).toFixed(4)
  token = token.replace(/0+$/, '').replace(/\.$/, '')
  return token === '-0' ? '0' : token
}
function pdfRgb(hex: string) {
  return [1, 3, 5].map((offset) => pdfChannel(Number.parseInt(hex.slice(offset, offset + 2), 16))).join(' ')
}
function paintOf(n: DesignNode, hex: string) {
  n.fills = [paint(hex)]
  return n
}
function inspectPdf(bytes: Uint8Array) {
  const text = new TextDecoder('latin1').decode(bytes)
  const media = text.match(/\/MediaBox \[([^\]]+)\]/)?.[1] ?? ''
  const start = text.indexOf('stream\n')
  const end = start < 0 ? -1 : text.indexOf('\nendstream', start)
  const content = start >= 0 && end > start ? text.slice(start + 'stream\n'.length, end) : ''
  return {
    text,
    media,
    content,
    images: text.match(/\/Subtype \/Image\b/g)?.length ?? 0,
    header: text.startsWith('%PDF'),
    eof: text.trimEnd().endsWith('%%EOF'),
    paths: /\bm\b/.test(content) && /\bf\*/.test(content),
  }
}
function decodePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = -1
  let interlace = -1
  const idat: Uint8Array[] = []
  let srgb = false
  let iccp = false
  let cicp = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      bitDepth = bytes[offset + 16]
      colorType = bytes[offset + 17]
      interlace = bytes[offset + 20]
    } else if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    else if (type === 'sRGB') srgb = true
    else if (type === 'iCCP') iccp = true
    else if (type === 'cICP') cicp = true
    else if (type === 'IEND') break
    offset += 12 + length
  }
  expect(colorType).toBe(6)
  expect(interlace).toBe(0)
  expect([8, 16]).toContain(bitDepth)
  const channels = 4
  const bpp = channels * (bitDepth / 8)
  const raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))))
  const stride = width * bpp
  const pixels = new Uint8Array(width * height * bpp)
  let source = 0
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const row = raw.subarray(source, source + stride)
    source += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bpp ? out[index - bpp] : 0
      const up = previous[index]
      const upLeft = index >= bpp ? previous[index - bpp] : 0
      const value = row[index]
      if (filter === 0) out[index] = value
      else if (filter === 1) out[index] = (value + left) & 255
      else if (filter === 2) out[index] = (value + up) & 255
      else if (filter === 3) out[index] = (value + ((left + up) >> 1)) & 255
      else {
        const estimate = left + up - upLeft
        const pa = Math.abs(estimate - left)
        const pb = Math.abs(estimate - up)
        const pc = Math.abs(estimate - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        out[index] = (value + predictor) & 255
      }
    }
    previous = out
  }
  return { width, height, bitDepth, pixels, srgb, iccp, cicp }
}
function pixel(png: ReturnType<typeof decodePng>, x: number, y: number) {
  const bpp = png.bitDepth === 16 ? 8 : 4
  const index = (y * png.width + x) * bpp
  if (png.bitDepth === 8) return [...png.pixels.subarray(index, index + 4)]
  const sample = (offset: number) => (png.pixels[index + offset] << 8) | png.pixels[index + offset + 1]
  return [0, 2, 4, 6].map(sample)
}
function expectEncoded(sample: number[], hex: string, bitDepth: number) {
  const authored = hexPixel(hex)
  for (let channel = 0; channel < 3; channel += 1) {
    const encoded = bitDepth === 16 ? Math.round((sample[channel] / 65535) * 255) : sample[channel]
    expect(Math.abs(encoded - authored[channel])).toBeLessThanOrEqual(1)
  }
  expect(sample[3]).toBe(bitDepth === 16 ? 65535 : 255)
}
function hexPixel(hex: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).concat(255)
}

type Layout = 'absolute' | 'auto'
function frameWith(layout: Layout, childA: DesignNode, childB: DesignNode) {
  const frame = node('frame', 40, 30, 220, 100)
  frame.name = 'Frame'
  frame.clip = true
  frame.children = [childA.id, childB.id]
  if (layout === 'auto') frame.layout = { ...defaultLayout(), mode: 'horizontal', gap: 8, padding: [0, 0, 0, 0] }
  return frame
}
function fourNodeDocument(layout: Layout) {
  const doc = blank('四节点')
  const childA = paintOf(node('rectangle', layout === 'absolute' ? 16 : 0, layout === 'absolute' ? 24 : 0, 80, 40), red)
  const childB = paintOf(node('rectangle', layout === 'absolute' ? 110 : 0, layout === 'absolute' ? 24 : 0, 60, 40), blue)
  const rootC = paintOf(node('rectangle', 300, 40, 70, 90), green)
  childA.name = 'Child A'
  childB.name = 'Child B'
  rootC.name = 'Root C'
  const frame = frameWith(layout, childA, childB)
  doc.nodes = { [frame.id]: frame, [childA.id]: childA, [childB.id]: childB, [rootC.id]: rootC }
  doc.pages[0].children = [frame.id, rootC.id]
  return { doc, frame, childA, childB, rootC }
}
function solo(hex: string, width: number, height: number) {
  const doc = blank('单节点')
  const shape = paintOf(node('rectangle', 0, 0, width, height), hex)
  shape.name = 'Root C'
  doc.nodes = { [shape.id]: shape }
  doc.pages[0].children = [shape.id]
  return { doc, shape }
}
async function vectorPdf(doc: DesignDocument, pageId: string, target: ExportTarget = { kind: 'page' }) {
  const before = JSON.stringify(doc)
  const asset = await exportPdfVector(doc, pageId, target)
  expect(JSON.stringify(doc)).toBe(before)
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  const pdf = inspectPdf(bytes)
  expect(pdf.header).toBe(true)
  expect(pdf.eof).toBe(true)
  expect(pdf.images).toBe(0)
  expect(pdf.paths).toBe(true)
  expect(asset.vector).toBe(true)
  expect(asset.fallback).toBeUndefined()
  expect(pdf.media).toBe(`0 0 ${asset.width} ${asset.height}`)
  const laid = kernelLayout(structuredClone(doc))
  expect(asset.width).toBe(Math.round(targetBounds(laid, pageId, target).width))
  expect(asset.height).toBe(Math.round(targetBounds(laid, pageId, target).height))
  expect(asset.blob.size).toBeGreaterThan(100)
  return { asset, pdf, bytes }
}

test('native admission still rejects a node the page cannot reach', () => {
  const doc = blank(), kept = node('rectangle', 0, 0, 10, 10), extra = node('rectangle', 30, 0, 10, 10)
  doc.nodes = { [kept.id]: kept, [extra.id]: extra }
  doc.pages[0].children = [kept.id]
  const engine = new VectorEngine()
  try {
    expect(() => engine.load_document(JSON.stringify(doc))).toThrow(/Unreachable node/)
  } finally {
    engine.free()
  }
})

test.each(['absolute', 'auto'] as const)('vector PDF 6-cell matrix keeps the requested target (%s)', async (layout) => {
  const { doc, frame, childA, childB, rootC } = fourNodeDocument(layout)
  expect(validateDocument(doc)).toBe(doc)
  expect(Object.keys(doc.nodes)).toHaveLength(4)
  const pageId = doc.pages[0].id
  const childTarget: ExportTarget = { kind: 'selection', nodeIds: [childA.id] }
  const rootTarget: ExportTarget = { kind: 'selection', nodeIds: [rootC.id] }
  const bothTarget: ExportTarget = { kind: 'selection', nodeIds: [frame.id, rootC.id] }
  const bothWithChildren: ExportTarget = { kind: 'selection', nodeIds: [frame.id, childA.id, childB.id, rootC.id] }
  const childSolo = solo(red, childA.width, childA.height)
  const rootSolo = solo(green, rootC.width, rootC.height)
  const failures: string[] = []
  const record = async (cell: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      failures.push(`${cell}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await record('only Root C', async () => {
    const selected = await vectorPdf(doc, pageId, rootTarget)
    const alone = await vectorPdf(rootSolo.doc, rootSolo.doc.pages[0].id, { kind: 'selection', nodeIds: [rootSolo.shape.id] })
    expect(selected.pdf.content).toBe(alone.pdf.content)
    expect(selected.pdf.media).toBe(alone.pdf.media)
    expect(selected.pdf.content).toContain(`${pdfRgb(green)} rg`)
    expect(selected.pdf.content).not.toContain(`${pdfRgb(red)} rg`)
    expect(selected.pdf.content).not.toContain(`${pdfRgb(blue)} rg`)
    expect(selected.asset.width).toBe(70)
    expect(selected.asset.height).toBe(90)
  })
  await record('only Child A', async () => {
    const selected = await vectorPdf(doc, pageId, childTarget)
    const alone = await vectorPdf(childSolo.doc, childSolo.doc.pages[0].id, { kind: 'selection', nodeIds: [childSolo.shape.id] })
    expect(selected.pdf.content).toBe(alone.pdf.content)
    expect(selected.pdf.media).toBe('0 0 80 40')
    expect(selected.pdf.content).toContain(`${pdfRgb(red)} rg`)
    expect(selected.pdf.content).not.toContain(`${pdfRgb(blue)} rg`)
    expect(selected.pdf.content).not.toContain(`${pdfRgb(green)} rg`)
    expect(selected.pdf.content).not.toMatch(/W\*? n/)
  })
  await record('whole page', async () => {
    const page = await vectorPdf(doc, pageId)
    const tight = await vectorPdf(doc, pageId, bothTarget)
    expect(page.asset.width).toBeGreaterThan(tight.asset.width)
    expect(page.asset.height).toBeGreaterThan(tight.asset.height)
    expect(page.pdf.content).toContain(`${pdfRgb(red)} rg`)
    expect(page.pdf.content).toContain(`${pdfRgb(blue)} rg`)
    expect(page.pdf.content).toContain(`${pdfRgb(green)} rg`)
  })
  await record('both roots', async () => {
    const roots = await vectorPdf(doc, pageId, bothTarget)
    const withChildren = await vectorPdf(doc, pageId, bothWithChildren)
    expect(withChildren.pdf.content).toBe(roots.pdf.content)
    expect(withChildren.pdf.media).toBe(roots.pdf.media)
    expect(roots.pdf.content).toContain(`${pdfRgb(red)} rg`)
    expect(roots.pdf.content).toContain(`${pdfRgb(green)} rg`)
    expect(roots.pdf.content).toMatch(/W\* n/)
  })
  await record('document with only Root C', async () => {
    const only = solo(green, rootC.width, rootC.height)
    only.shape.name = 'Root C'
    expect(Object.keys(only.doc.nodes)).toHaveLength(1)
    const selected = await vectorPdf(only.doc, only.doc.pages[0].id, { kind: 'selection', nodeIds: [only.shape.id] })
    expect(selected.pdf.content).toBe((await vectorPdf(rootSolo.doc, rootSolo.doc.pages[0].id, { kind: 'selection', nodeIds: [rootSolo.shape.id] })).pdf.content)
    expect(selected.pdf.media).toBe('0 0 70 90')
    expect(selected.pdf.content).toContain(`${pdfRgb(green)} rg`)
  })
  await record('current page of a 2-page document', async () => {
    const multi = fourNodeDocument(layout)
    const other = paintOf(node('rectangle', 12, 18, 36, 28), purple)
    other.name = 'Other page'
    const second = { id: uid(), name: '页面 2', children: [other.id], background: '#f5f5f5' }
    delete multi.doc.nodes[multi.childB.id]
    multi.frame.children = [multi.childA.id]
    multi.doc.nodes[other.id] = other
    multi.doc.pages.push(second)
    expect(validateDocument(multi.doc)).toBe(multi.doc)
    expect(Object.keys(multi.doc.nodes)).toHaveLength(4)
    expect(multi.doc.pages).toHaveLength(2)
    const current = await vectorPdf(multi.doc, multi.doc.pages[0].id)
    expect(current.pdf.content).toContain(`${pdfRgb(red)} rg`)
    expect(current.pdf.content).toContain(`${pdfRgb(green)} rg`)
    expect(current.pdf.content).not.toContain(`${pdfRgb(purple)} rg`)
    expect(current.pdf.content).not.toContain(`${pdfRgb(blue)} rg`)
    const otherPage = await vectorPdf(multi.doc, second.id)
    expect(otherPage.pdf.content).toContain(`${pdfRgb(purple)} rg`)
    expect(otherPage.pdf.content).not.toContain(`${pdfRgb(red)} rg`)
    expect(otherPage.pdf.media).not.toBe(current.pdf.media)
  })
  expect(failures, failures.join('\n\n')).toEqual([])
})

test('child selection keeps its own world size and excludes ancestor clip, siblings and effects', async () => {
  installExportWorker()
  const doc = blank('裁切')
  const child = paintOf(node('rectangle', 70, 10, 80, 40), red)
  const frame = node('frame', 0, 0, 100, 80)
  frame.clip = true
  frame.children = [child.id]
  const sibling = paintOf(node('rectangle', 220, 10, 30, 30), blue)
  doc.nodes = { [frame.id]: frame, [child.id]: child, [sibling.id]: sibling }
  doc.pages[0].children = [frame.id, sibling.id]
  const alone = solo(red, 80, 40)
  const selected = await vectorPdf(doc, doc.pages[0].id, { kind: 'selection', nodeIds: [child.id] })
  const reference = await vectorPdf(alone.doc, alone.doc.pages[0].id, { kind: 'selection', nodeIds: [alone.shape.id] })
  expect(selected.pdf.content).toBe(reference.pdf.content)
  expect(selected.pdf.media).toBe('0 0 80 40')
  expect(selected.pdf.content).not.toContain(`${pdfRgb(blue)} rg`)
  expect(selected.pdf.content).not.toMatch(/W\*? n/)
  const framed = await vectorPdf(doc, doc.pages[0].id, { kind: 'selection', nodeIds: [frame.id] })
  expect(framed.pdf.content).toMatch(/W\* n/)
  expect(framed.pdf.content).toContain(`${pdfRgb(red)} rg`)
  expect(framed.asset.width).toBe(100)
  expect(framed.asset.height).toBe(80)
  frame.effects = [effect('shadow')]
  const shadowed = await vectorPdf(doc, doc.pages[0].id, { kind: 'selection', nodeIds: [child.id] })
  expect(shadowed.pdf.content).toBe(reference.pdf.content)
  expect(shadowed.pdf.content).not.toContain(`${pdfRgb(shadow)} rg`)
  const bitmap = await exportImage(doc, doc.pages[0].id, 'pdf', 1, undefined, undefined, { kind: 'selection', nodeIds: [frame.id] })
  expect(inspectPdf(new Uint8Array(await bitmap.blob.arrayBuffer())).images).toBeGreaterThan(0)
})

test('multi-page metadata and an outside component still admit without editing the author document', async () => {
  const doc = blank('引用')
  doc.schemaVersion = 10
  const kept = paintOf(node('rectangle', 8, 12, 48, 32), red)
  const link = node('vector', 4, 4, 40, 12)
  const main = node('frame', 0, 0, 50, 40)
  const inner = paintOf(node('rectangle', 6, 8, 18, 14), blue)
  main.children = [inner.id]
  main.component = { variants: {}, properties: {} }
  doc.nodes = { [kept.id]: kept, [link.id]: link, [main.id]: main, [inner.id]: inner }
  doc.pages[0].children = [main.id]
  stampKeys(doc, main.id)
  const instanceId = insertInstance(doc, main.id, doc.pages[0].id, { x: 180, y: 70 })
  const other = paintOf(node('rectangle', 10, 10, 24, 24), purple)
  const second = { id: uid(), name: '页面 2', children: [other.id], background: '#f5f5f5' }
  doc.pages.push(second)
  doc.nodes[other.id] = other
  link.connector = {
    from: { point: { x: 0, y: 0 }, nodeId: kept.id, anchor: { x: 1, y: 0.5 } },
    to: { point: { x: 40, y: 12 }, nodeId: other.id, anchor: { x: 0, y: 0.5 } },
    style: 'straight',
  }
  doc.pages[0].children.push(kept.id, link.id)
  doc.prototype = {
    startNode: kept.id,
    interactions: {
      [kept.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: other.id, durationMs: 100 }] }],
      [other.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: kept.id, durationMs: 100 }] }],
    },
  }
  doc.reviews = [
    { id: uid(), pageId: doc.pages[0].id, nodeId: kept.id, position: { x: 4, y: 6 }, kind: 'comment', resolved: false, messages: [{ id: uid(), author: '本机', text: '当前页', createdAt: 1 }] },
    { id: uid(), pageId: second.id, nodeId: other.id, position: { x: 2, y: 2 }, kind: 'comment', resolved: false, messages: [{ id: uid(), author: '本机', text: '另一页', createdAt: 2 }] },
  ]
  doc.animations = [createClip(doc, doc.pages[0].id, [kept.id], false), createClip(doc, second.id, [other.id], false)]
  expect(validateDocument(doc)).toBe(doc)
  const editor = new Editor(doc)
  try {
    const version = editor.state.version
    const before = JSON.stringify(editor.state.doc)
    const page = await vectorPdf(editor.state.doc, editor.state.page)
    const instance = await vectorPdf(editor.state.doc, editor.state.page, { kind: 'selection', nodeIds: [instanceId] })
    expect(editor.state.version).toBe(version)
    expect(editor.canUndo).toBe(false)
    expect(JSON.stringify(editor.state.doc)).toBe(before)
    expect(page.pdf.content).toContain(`${pdfRgb(red)} rg`)
    expect(page.pdf.content).not.toContain(`${pdfRgb(purple)} rg`)
    expect(instance.pdf.media).toBe('0 0 50 40')
    expect(instance.pdf.content).toContain(`${pdfRgb(blue)} rg`)
    expect(instance.pdf.content).not.toContain(`${pdfRgb(purple)} rg`)
    expect(editor.state.doc.prototype?.interactions[other.id]).toHaveLength(1)
    expect(editor.state.doc.reviews).toHaveLength(2)
    expect(editor.state.doc.animations).toHaveLength(2)
    expect(editor.state.doc.nodes[main.id].component).toBeDefined()
    expect(editor.state.doc.nodes[link.id].connector?.to.nodeId).toBe(other.id)
  } finally {
    editor.dispose()
  }
})

test('selection SVG, PNG, bitmap PDF and ordinary sRGB presets stay real files', async () => {
  installExportWorker()
  const { doc, childA, rootC } = fourNodeDocument('absolute')
  const pageId = doc.pages[0].id
  const target: ExportTarget = { kind: 'selection', nodeIds: [childA.id] }
  const before = JSON.stringify(doc)
  const svg = await exportImage(doc, pageId, 'svg', 1, undefined, undefined, target)
  const svgText = await svg.blob.text()
  expect(svgText).toContain('width="80"')
  expect(svgText).toContain('height="40"')
  expect(svgText).toContain(red)
  expect(svgText).not.toContain(blue)
  expect(svgText).not.toContain(green)
  const png = await exportImage(doc, pageId, 'png', 1, undefined, undefined, target)
  const decoded = decodePng(new Uint8Array(await png.blob.arrayBuffer()))
  expect(decoded.srgb).toBe(true)
  expect(decoded.iccp).toBe(true)
  expect(decoded.width).toBe(png.width)
  expect(decoded.height).toBe(png.height)
  expect(decoded.bitDepth).toBe(8)
  expect(pixel(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2))).toEqual(hexPixel(red))
  const alone = solo(red, 80, 40)
  const alonePng = await exportImage(alone.doc, alone.doc.pages[0].id, 'png', 1, undefined, undefined, {
    kind: 'selection',
    nodeIds: [alone.shape.id],
  })
  expect(decodePng(new Uint8Array(await alonePng.blob.arrayBuffer())).pixels).toEqual(decoded.pixels)
  const jpeg = await exportImage(doc, pageId, 'jpeg', 1, undefined, undefined, target)
  const webp = await exportImage(doc, pageId, 'webp', 1, undefined, undefined, target)
  const bitmap = await exportImage(doc, pageId, 'pdf', 1, undefined, undefined, target)
  const bitmapBytes = new Uint8Array(await bitmap.blob.arrayBuffer())
  const bitmapPdf = inspectPdf(bitmapBytes)
  expect(bitmapPdf.header).toBe(true)
  expect(bitmapPdf.images).toBeGreaterThan(0)
  expect(jpeg.blob.size).toBeGreaterThan(100)
  expect(webp.blob.size).toBeGreaterThan(100)
  expect(new Uint8Array(await jpeg.blob.arrayBuffer()).subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]))
  expect(new TextDecoder().decode(new Uint8Array(await webp.blob.arrayBuffer()).subarray(0, 12))).toContain('WEBP')
  expect(JSON.stringify(doc)).toBe(before)
  doc.schemaVersion = 4
  doc.colorManagement = defaultColorSettings()
  doc.rasterProfile = 'figma'
  const managed = JSON.stringify(doc)
  const output = layerExportColorOutput(doc, rootC.id, '')
  expect(output).toEqual({ space: 'srgb', toneMap: 'clip' })
  const presetPng = await exportImage(doc, pageId, 'png', 2, output, undefined, { kind: 'selection', nodeIds: [rootC.id] })
  const preset = decodePng(new Uint8Array(await presetPng.blob.arrayBuffer()))
  expect(preset.srgb).toBe(true)
  expect(preset.cicp).toBe(true)
  expect(preset.bitDepth).toBe(16)
  expectEncoded(pixel(preset, Math.floor(preset.width / 2), Math.floor(preset.height / 2)), green, preset.bitDepth)
  const managedSolo = solo(green, rootC.width, rootC.height)
  managedSolo.doc.schemaVersion = 4
  managedSolo.doc.colorManagement = defaultColorSettings()
  managedSolo.doc.rasterProfile = 'figma'
  const managedSoloPng = await exportImage(managedSolo.doc, managedSolo.doc.pages[0].id, 'png', 2, output, undefined, {
    kind: 'selection',
    nodeIds: [managedSolo.shape.id],
  })
  expect(decodePng(new Uint8Array(await managedSoloPng.blob.arrayBuffer())).pixels).toEqual(preset.pixels)
  const presetPdf = await exportImage(doc, pageId, 'pdf-vector', 1, output, undefined, { kind: 'selection', nodeIds: [rootC.id] })
  const presetVector = inspectPdf(new Uint8Array(await presetPdf.blob.arrayBuffer()))
  expect(presetPdf.vector).toBe(true)
  expect(presetPdf.fallback).toBeUndefined()
  expect(presetVector.images).toBe(0)
  expect(presetVector.content).toContain(`${pdfRgb(green)} rg`)
  const wide = structuredClone(doc)
  wide.nodes[childA.id].fills[0].color = 'color(srgb 1.4 0 0)'
  expect(() => layerExportColorOutput(wide, childA.id, '')).toThrow(/不会静默裁成 8 位/)
  expect(JSON.stringify(doc)).toBe(managed)
})
