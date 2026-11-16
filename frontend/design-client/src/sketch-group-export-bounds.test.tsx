// Recreated Sketch control for issue 484. The archive is built here and imported
// through the product Sketch codec. Native PNG sizes are the documented
// Sketch 2026.3.1 table; this VM does not run sketchtool.
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { Inspector } from './Inspector'
import { targetBounds } from './export'
import { interfacePreference } from './interface-preference'
import { import_sketch_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, uid, type Bounds, type DesignDocument, type DesignNode } from './model'
import type { KernelOptions } from './kernel/client'

const LAYER = { width: 41.25, height: 28.6 }
const SCALES = [0.2, 0.5, 1, 2] as const
const ORIGINS = {
  'group-zero': { x: 0, y: 0 },
  'group-fractional': { x: 2.5, y: -1.5 },
  'group-negative': { x: -112.25, y: 90.15 },
  'group-integer': { x: 8, y: -4 },
} as const

/** Documented native Sketch sizes for an ordinary group around the 41.25×28.6 bitmap. */
const NATIVE_GROUP: Record<keyof typeof ORIGINS, Record<number, [number, number]>> = {
  'group-zero': { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29], 2: [84, 58] },
  'group-fractional': { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 30], 2: [84, 60] },
  'group-negative': { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29], 2: [84, 58] },
  'group-integer': { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29], 2: [84, 58] },
}

type Png = { width: number; height: number; rgba: Uint8Array }
type Shot = { name: string; scale: number; png: Png; sha256: string; bounds: Bounds }

const regions: { bounds?: Bounds; scale?: number; nodeIds?: string[] }[] = []
class ExportCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor(_url?: URL, _options?: { type?: string }) {}
  postMessage(request: { id?: number; command?: string; document?: string; options?: KernelOptions; png?: boolean }) {
    queueMicrotask(() => {
      if (this.terminated || request.command || request.id === undefined || !request.options?.exportRegion) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const region = request.options.exportRegion
        regions.push({ bounds: region.bounds, scale: region.scale, nodeIds: region.nodeIds })
        const rendered = this.engine.render_region_png(JSON.stringify({
          pageId: request.options.pageId,
          ...region,
          rasterProfile: request.options.rasterProfile,
          colorOutput: request.options.colorOutput,
        }))
        const copy = rendered.slice()
        this.onmessage?.({ data: { id: request.id, buffer: copy.buffer, stats: {}, backend: 'cpu', milliseconds: 0 } })
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

const urls: { url: string; blob: Blob }[] = []
let dom: JSDOM | undefined
function installDom() {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  const window = dom.window
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'Document', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? window : window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', ExportCpuWorker)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  urls.length = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => {
    const url = `blob:layer-${urls.length}`
    urls.push({ url, blob: value as Blob })
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}

afterEach(() => {
  interfacePreference.set({ locale: 'zh-CN', uiMode: 'figma' })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  dom?.window.close()
  dom = undefined
})

function crc32(buf: Uint8Array) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function pngChunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function solidPng(width: number, height: number, pixel: [number, number, number, number]) {
  const raw = Buffer.alloc((1 + width * 4) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      raw[i] = pixel[0]; raw[i + 1] = pixel[1]; raw[i + 2] = pixel[2]; raw[i + 3] = pixel[3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
function paeth(left: number, up: number, upLeft: number) {
  const p = left + up - upLeft
  const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
}
function decodePng(bytes: Uint8Array): Png {
  const file = Buffer.from(bytes)
  if (file.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG signature missing')
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0
  const idat: Buffer[] = []
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    const data = file.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; color = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error(`Unexpected PNG ${depth}/${color}/interlace ${interlace}`)
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(width * height * 4)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[cursor++]
    const row = Buffer.from(inflated.subarray(cursor, cursor + stride))
    cursor += stride
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0
      const up = previous[i]
      const upLeft = i >= 4 ? previous[i - 4] : 0
      if (filter === 1) row[i] = (row[i] + left) & 255
      else if (filter === 2) row[i] = (row[i] + up) & 255
      else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255
      else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 255
      else if (filter !== 0) throw new Error(`PNG filter ${filter}`)
    }
    rgba.set(row, y * stride)
    previous = row
  }
  return { width, height, rgba }
}
function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
function alpha(png: Png, x: number, y: number) {
  return png.rgba[(y * png.width + x) * 4 + 3]
}
function rowCoverage(png: Png, y: number) {
  let sum = 0
  for (let x = 0; x < png.width; x++) sum += alpha(png, x, y)
  return sum
}
function renderSelection(doc: DesignDocument, pageId: string, id: string, bounds: Bounds, scale: number) {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    const bytes = new Uint8Array(engine.render_region_png(JSON.stringify({
      pageId, bounds, scale, nodeIds: [id],
      rasterProfile: doc.rasterProfile || (doc.colorManagement ? 'figma' : 'analytic'),
    })).slice())
    return { png: decodePng(bytes), sha256: sha256(bytes) }
  } finally { engine.free() }
}
function tightPixels(length: number, scale: number) {
  const value = length * scale
  const integer = Math.round(value)
  if (integer >= 1 && Math.abs(value - integer) <= 8 * Number.EPSILON * Math.max(Math.abs(value), 1)) return integer
  return Math.ceil(value)
}

function formats(scales: readonly number[]) {
  return {
    _class: 'exportOptions', shouldTrim: false, layerOptions: 0, includedLayerIds: [],
    exportFormats: scales.map(scale => ({ _class: 'exportFormat', fileFormat: 'png', scale, name: `@${scale}x` })),
  }
}
function bitmapLayer(id: string, name: string, x: number, y: number, scales?: readonly number[]) {
  return {
    _class: 'bitmap', do_objectID: id, name, isVisible: true,
    frame: { _class: 'rect', x, y, width: LAYER.width, height: LAYER.height },
    clippingMask: '{{0, 0}, {1, 1}}', fillReplacesImage: false,
    image: { _class: 'MSJSONFileReference', _ref_class: 'MSImageData', _ref: 'images/opaque.png' },
    ...(scales ? { exportOptions: formats(scales) } : {}),
  }
}
function controlArchive() {
  const page = '10000000-0000-4000-8000-000000000484'
  const group = (name: keyof typeof ORIGINS, id: string) => ({
    _class: 'group', do_objectID: id, name, isVisible: true, groupBehavior: 0,
    frame: { _class: 'rect', x: ORIGINS[name].x, y: ORIGINS[name].y, width: LAYER.width, height: LAYER.height },
    groupLayout: { _class: 'MSImmutableFreeformGroupLayout' },
    exportOptions: formats(SCALES),
    layers: [bitmapLayer(`${id}-bitmap`, `${name}-bitmap`, 0, 0)],
  })
  const slice = {
    _class: 'slice', do_objectID: 'slice-fractional', name: 'slice-fractional', isVisible: true,
    frame: { _class: 'rect', x: -12.375, y: 7.125, width: 12.25, height: 9.5 },
    exportOptions: formats([1, 2]),
  }
  return zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 168, appVersion: '2026.3.1', commit: 'futureox-control-484' })),
    'document.json': strToU8(JSON.stringify({
      _class: 'document', do_objectID: 'control-484',
      pages: [{ _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: `pages/${page}` }],
    })),
    [`pages/${page}.json`]: strToU8(JSON.stringify({
      _class: 'page', do_objectID: page, name: 'Control',
      layers: [
        group('group-zero', 'group-zero'),
        group('group-fractional', 'group-fractional'),
        group('group-negative', 'group-negative'),
        group('group-integer', 'group-integer'),
        bitmapLayer('bitmap-direct', 'bitmap-direct', 2.5, -1.5, SCALES),
        slice,
      ],
    })),
    'images/opaque.png': solidPng(4, 4, [220, 30, 40, 255]),
  })
}

function named(doc: DesignDocument, name: string) {
  const found = Object.values(doc.nodes).find(item => item.name === name)
  if (!found) throw new Error(`Missing layer ${name}`)
  return found
}

async function clickExport(root: Root, editor: Editor, layer: DesignNode, mode: 'figma' | 'sketch') {
  interfacePreference.set({ locale: 'zh-CN', uiMode: mode })
  await act(async () => {
    editor.select([layer.id])
    root.render(<Inspector editor={editor} />)
  })
  const inspector = document.querySelector('.inspector')
  expect(inspector?.getAttribute('data-geometry-mode'), mode).toBe(mode)
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === '预览并导出此图层')
  expect(button, `${mode} ${layer.name}`).toBeTruthy()
  const started = urls.length
  const startedRegions = regions.length
  await act(async () => { button!.click() })
  await vi.waitFor(() => {
    const status = document.querySelector('[role="status"]')?.textContent ?? ''
    expect(status, status).toMatch(/已生成 \d+ 个文件/)
  }, { timeout: 60000 })
  const links = [...document.querySelectorAll('a[download], a[href^="blob:"]')]
  const shots: Shot[] = []
  for (const link of links) {
    const href = link.getAttribute('href')
    const stored = urls.find(item => item.url === href)
    if (!stored) continue
    const bytes = new Uint8Array(await stored.blob.arrayBuffer())
    const png = decodePng(bytes)
    const scale = Number(/^@([\d.]+)x\.png$/.exec(link.textContent?.slice(layer.name.length) ?? '')?.[1])
    const region = regions.slice(startedRegions).find(item => item.scale === scale)
    shots.push({
      name: layer.name, scale, png, sha256: sha256(bytes),
      bounds: region?.bounds ?? { x: NaN, y: NaN, width: NaN, height: NaN },
    })
  }
  expect(shots, `${mode} ${layer.name}`).toHaveLength(layer.exportSettings?.length ?? 0)
  expect(urls.length - started).toBe(shots.length)
  return shots
}

test('opaque control PNG round-trips', () => {
  const png = decodePng(solidPng(4, 4, [220, 30, 40, 255]))
  expect([png.width, png.height]).toEqual([4, 4])
  expect(png.rgba[0]).toBe(220)
  expect(png.rgba[3]).toBe(255)
})

test('both layouts click-export the recreated Sketch group control', async () => {
  installDom()
  const report = JSON.parse(import_sketch_json(controlArchive())) as { document: DesignDocument }
  const editor = new Editor(report.document)
  const root = createRoot(document.getElementById('root')!)
  const layers = ['group-zero', 'group-fractional', 'group-negative', 'group-integer', 'bitmap-direct', 'slice-fractional']
  try {
    for (const name of layers) {
      const layer = named(editor.state.doc, name)
      if (name.startsWith('group-')) {
        expect(layer.kind).toBe('group')
        expect(layer.effects.filter(effect => effect.visible)).toEqual([])
        const child = editor.state.doc.nodes[layer.children[0]]
        const metadata = editor.state.doc.designSystem?.sketchContainers?.nodeMetadata as
          | Record<string, { bindings?: Record<string, string> }>
          | undefined
        expect(child.kind).toBe('rectangle')
        expect(child.fills[0]?.kind).toBe('image')
        expect(child.fills[0]?.fit).toBe('stretch')
        expect(metadata?.[child.id]?.bindings?.sketchSourceBitmap).toBe('true')
        expect(child.effects.filter(effect => effect.visible)).toEqual([])
        expect(child.width).toBeCloseTo(LAYER.width, 8)
        expect(child.height).toBeCloseTo(LAYER.height, 8)
      }
    }
    const byMode: Record<string, Shot[]> = {}
    for (const mode of ['figma', 'sketch'] as const) {
      byMode[mode] = []
      for (const name of layers) byMode[mode].push(...await clickExport(root, editor, named(editor.state.doc, name), mode))
    }
    const summary = byMode.figma.map(shot => {
      const sketch = byMode.sketch.find(item => item.name === shot.name && item.scale === shot.scale)!
      const origin = ORIGINS[shot.name as keyof typeof ORIGINS]
      return {
        name: shot.name, scale: shot.scale,
        size: [shot.png.width, shot.png.height] as [number, number],
        bounds: shot.bounds,
        identicalToSketchLayout: shot.sha256 === sketch.sha256,
        native: origin ? NATIVE_GROUP[shot.name as keyof typeof ORIGINS][shot.scale] : undefined,
      }
    })
    expect(summary.every(item => item.identicalToSketchLayout)).toBe(true)
    for (const item of summary) {
      if (!item.native) continue
      const origin = ORIGINS[item.name as keyof typeof ORIGINS]
      const x = Math.floor(origin.x)
      const y = Math.floor(origin.y)
      expect(item.size, JSON.stringify(item)).toEqual(item.native)
      expect(item.bounds, JSON.stringify(item)).toEqual({
        x, y,
        width: Math.ceil(origin.x + LAYER.width) - x,
        height: Math.ceil(origin.y + LAYER.height) - y,
      })
    }
    const bitmap = summary.filter(item => item.name === 'bitmap-direct')
    expect(bitmap.map(item => item.size)).toEqual(SCALES.map(scale => [tightPixels(LAYER.width, scale), tightPixels(LAYER.height, scale)]))
    expect(bitmap.find(item => item.scale === 2)?.size).toEqual([83, 58])
    expect(bitmap.every(item => item.bounds.x === 2.5 && item.bounds.y === -1.5 && item.bounds.width === LAYER.width)).toBe(true)
    const slice = summary.filter(item => item.name === 'slice-fractional')
    expect(slice.map(item => item.size)).toEqual([[13, 10], [25, 19]])
    expect(slice.every(item => item.bounds.x === -12.375 && item.bounds.width === 12.25)).toBe(true)
    const fractional = byMode.figma.find(item => item.name === 'group-fractional' && item.scale === 0.5)!
    const fractionalLayer = named(editor.state.doc, 'group-fractional')
    const fractionalTight = targetBounds(editor.state.doc, editor.state.page, { kind: 'selection', nodeIds: [fractionalLayer.id] })
    const tightHalf = renderSelection(editor.state.doc, editor.state.page, fractionalLayer.id, fractionalTight, 0.5)
    expect([fractional.png.width, fractional.png.height]).toEqual([tightHalf.png.width, tightHalf.png.height])
    expect(fractional.sha256).not.toBe(tightHalf.sha256)
    expect(rowCoverage(fractional.png, fractional.png.height - 1)).not.toBe(rowCoverage(tightHalf.png, tightHalf.png.height - 1))
    const direct = byMode.figma.find(item => item.name === 'bitmap-direct' && item.scale === 2)!
    const directLayer = named(editor.state.doc, 'bitmap-direct')
    const directTight = targetBounds(editor.state.doc, editor.state.page, { kind: 'selection', nodeIds: [directLayer.id] })
    const tightBitmap = renderSelection(editor.state.doc, editor.state.page, directLayer.id, directTight, 2)
    expect([tightBitmap.png.width, tightBitmap.png.height]).toEqual([83, 58])
    expect(direct.sha256).toBe(tightBitmap.sha256)
  } finally {
    await act(async () => root.unmount())
    editor.dispose()
  }
}, 180000)

test('Figma raster groups keep the tight export contract through the same click', async () => {
  installDom()
  const doc = blank('Figma group contract')
  doc.schemaVersion = 10
  doc.rasterProfile = 'figma'
  const child = node('rectangle', 0, 0, LAYER.width, LAYER.height)
  const group = node('group', 2.5, -1.5, LAYER.width, LAYER.height)
  group.name = 'figma-group'
  group.children = [child.id]
  group.exportSettings = SCALES.map(scale => ({ id: uid(), format: 'png' as const, scale, suffix: `@${scale}x` }))
  doc.nodes = { [group.id]: group, [child.id]: child }
  doc.pages[0].children = [group.id]
  const editor = new Editor(doc)
  const root = createRoot(document.getElementById('root')!)
  try {
    const tight = targetBounds(editor.state.doc, editor.state.page, { kind: 'selection', nodeIds: [group.id] })
    expect(tight).toMatchObject({ x: 2.5, y: -1.5, width: LAYER.width, height: LAYER.height })
    const shots = await clickExport(root, editor, named(editor.state.doc, 'figma-group'), 'figma')
    const sketchShots = await clickExport(root, editor, named(editor.state.doc, 'figma-group'), 'sketch')
    expect(shots.map(shot => shot.sha256)).toEqual(sketchShots.map(shot => shot.sha256))
    expect(shots.map(shot => [shot.png.width, shot.png.height])).toEqual(
      SCALES.map(scale => [tightPixels(LAYER.width, scale), tightPixels(LAYER.height, scale)]),
    )
    expect(shots.find(shot => shot.scale === 2)).toMatchObject({ png: { width: 83, height: 58 }, bounds: { x: 2.5, y: -1.5 } })
    expect(shots.find(shot => shot.scale === 1)?.png).toMatchObject({ width: 42, height: 29 })
  } finally {
    await act(async () => root.unmount())
    editor.dispose()
  }
}, 120000)
