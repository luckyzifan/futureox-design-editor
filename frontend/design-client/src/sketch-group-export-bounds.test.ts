import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { import_sketch_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { exportImage, rasterExportBounds, svgSource, targetBounds } from './export'
import { interfacePreference } from './interface-preference'
import { NodeExportPanel } from './NodeExportPanel'
import type { KernelOptions } from './kernel/client'
import { blank, node, uid, type DesignDocument } from './model'

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGO4o6HxHxkzkC4AAJiYIrGEgq7pAAAAAElFTkSuQmCC',
  'base64',
))
const LAYER = { width: 41.25, height: 28.6 }
const PAGE = '11111111-1111-4111-8111-111111111111'
const DOCUMENT = '44444444-4444-4444-8444-444444444444'
const GROUP = '22222222-2222-4222-8222-222222222222'
const BITMAP = '33333333-3333-4333-8333-333333333333'

type RegionRequest = { id?: number; document?: string; options: KernelOptions; png?: boolean; command?: string }
const regionRequests: RegionRequest[] = []
class CpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  postMessage(request: RegionRequest) {
    if (request.command || request.id === undefined || !request.png) return
    regionRequests.push(request)
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const bytes = this.engine.render_region_png(JSON.stringify({
          pageId: request.options.pageId,
          ...request.options.exportRegion,
          rasterProfile: request.options.rasterProfile,
          colorOutput: request.options.colorOutput,
        }))
        this.onmessage?.({ data: { id: request.id, buffer: bytes.buffer, stats: JSON.parse(this.engine.stats()), backend: 'cpu' } })
      } catch (error) {
        this.onmessage?.({ data: { id: request.id, error: String(error) } })
      }
    })
  }
  terminate() { this.terminated = true; this.engine.free() }
}

function archive(origin: { x: number; y: number }) {
  const page = {
    _class: 'page', do_objectID: PAGE, name: 'Page',
    layers: [{
      _class: 'group', do_objectID: GROUP, name: 'Bitmap group',
      frame: { _class: 'rect', x: origin.x, y: origin.y, width: LAYER.width, height: LAYER.height },
      layers: [{
        _class: 'bitmap', do_objectID: BITMAP, name: 'Bitmap',
        frame: { _class: 'rect', x: 0, y: 0, width: LAYER.width, height: LAYER.height },
        clippingMask: '{{0, 0}, {1, 1}}',
        image: { _class: 'MSJSONFileReference', _ref: 'images/pixel.png', _ref_class: 'MSImageData' },
      }],
    }],
  }
  const document = {
    _class: 'document', do_objectID: DOCUMENT, colorSpace: 1,
    pages: [{ _class: 'MSJSONFileReference', _ref: `pages/${PAGE}` }],
  }
  return zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 136, appVersion: '2026.3.1' })),
    'document.json': strToU8(JSON.stringify(document)),
    [`pages/${PAGE}.json`]: strToU8(JSON.stringify(page)),
    'images/pixel.png': PNG,
  })
}

function imported(origin: { x: number; y: number }) {
  const report = JSON.parse(import_sketch_json(archive(origin))) as { document: DesignDocument }
  const doc = report.document
  // The file-open path replaces the codec's document id and keeps the file name.
  doc.id = DOCUMENT
  doc.name = 'control.sketch'
  const group = Object.values(doc.nodes).find(item => item.name === 'Bitmap group')
  const bitmap = Object.values(doc.nodes).find(item => item.name === 'Bitmap')
  if (!group || !bitmap) throw new Error('control layers missing')
  return { doc, group, bitmap, page: doc.pages[0].id }
}

function pngSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function pngOf(doc: DesignDocument, nodeId: string, scale: number) {
  const asset = await exportImage(doc, doc.pages[0].id, 'png', scale, undefined, undefined, { kind: 'selection', nodeIds: [nodeId] })
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  return { bytes, size: pngSize(bytes), hash: sha(bytes), width: asset.width, height: asset.height }
}

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.reset()
  vi.unstubAllGlobals()
  regionRequests.splice(0)
})

test('sketch group layer export uses native integer-point bounds at every measured scale', async () => {
  vi.stubGlobal('Worker', CpuWorker)
  const expected = (origin: { x: number; y: number }, scale: number) => {
    const { doc, group, page } = imported(origin)
    const box = rasterExportBounds(doc, page, { kind: 'selection', nodeIds: [group.id] })
    return {
      doc, group, page, box,
      width: Math.round(box.width * scale),
      height: Math.round(box.height * scale),
    }
  }
  const cases = [
    { origin: { x: 0, y: 0 }, scale: 2, width: 84, height: 58 },
    { origin: { x: 2.5, y: -1.5 }, scale: 1, width: 42, height: 30 },
    { origin: { x: 2.5, y: -1.5 }, scale: 2, width: 84, height: 60 },
    { origin: { x: -112.25, y: 90.15 }, scale: 2, width: 84, height: 58 },
    { origin: { x: 8, y: 5 }, scale: 2, width: 84, height: 58 },
  ]
  for (const item of cases) {
    const plan = expected(item.origin, item.scale)
    expect(plan.box.width * item.scale, JSON.stringify(item.origin)).toBe(item.width)
    expect(plan.box.height * item.scale).toBe(item.height)
    const group = await pngOf(plan.doc, plan.group.id, item.scale)
    expect(group.size).toEqual({ width: item.width, height: item.height })
    expect(group.width).toBe(item.width)
    expect(group.height).toBe(item.height)
  }
  const fractional = [
    { origin: { x: 0, y: 0 }, scales: { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29] } },
    { origin: { x: 2.5, y: -1.5 }, scales: { 0.2: [9, 6], 0.5: [21, 15] } },
    { origin: { x: -112.25, y: 90.15 }, scales: { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29] } },
    { origin: { x: 8, y: 5 }, scales: { 0.2: [9, 6], 0.5: [21, 15], 1: [42, 29] } },
  ] as const
  for (const item of fractional) {
    const { doc, group, bitmap } = imported(item.origin)
    for (const [scale, size] of Object.entries(item.scales)) {
      const rendered = await pngOf(doc, group.id, Number(scale))
      expect(rendered.size, `${item.origin.x},${item.origin.y} @${scale}`).toEqual({ width: size[0], height: size[1] })
    }
    const direct = await pngOf(doc, bitmap.id, 2)
    expect(direct.size, `bitmap ${item.origin.x},${item.origin.y}`).toEqual({ width: 83, height: 58 })
    const halfGroup = await pngOf(doc, group.id, 0.5)
    const halfBitmap = await pngOf(doc, bitmap.id, 0.5)
    expect(halfGroup.size).toEqual(halfBitmap.size)
    const box = rasterExportBounds(doc, doc.pages[0].id, { kind: 'selection', nodeIds: [group.id] })
    const tight = targetBounds(doc, doc.pages[0].id, { kind: 'selection', nodeIds: [bitmap.id] })
    const originMoved = box.x !== tight.x || box.y !== tight.y
    if (originMoved) expect(halfGroup.hash, `${item.origin.x},${item.origin.y}`).not.toBe(halfBitmap.hash)
    else expect(halfGroup.hash, `${item.origin.x},${item.origin.y}`).toBe(halfBitmap.hash)
  }
  const zero = imported({ x: 0, y: 0 })
  const svg = svgSource(zero.doc, zero.page, { kind: 'selection', nodeIds: [zero.group.id] })
  expect(svg.box.width).toBeCloseTo(41.25)
  expect(svg.box.height).toBeCloseTo(28.6)
  const figma = structuredClone(zero.doc)
  figma.rasterProfile = 'figma'
  expect(rasterExportBounds(figma, zero.page, { kind: 'selection', nodeIds: [zero.group.id] })).toEqual(
    targetBounds(figma, zero.page, { kind: 'selection', nodeIds: [zero.group.id] }),
  )
  expect((await pngOf(figma, zero.group.id, 2)).size).toEqual({ width: 83, height: 58 })
  const software = structuredClone(zero.doc)
  software.rasterProfile = 'figmaSoftware'
  expect(rasterExportBounds(software, zero.page, { kind: 'selection', nodeIds: [zero.group.id] }).width).toBeCloseTo(41.25)

  const plain = blank('本地编组')
  const group = node('group', 0, 0, LAYER.width, LAYER.height)
  const child = node('rectangle', 0, 0, LAYER.width, LAYER.height)
  group.children = [child.id]
  plain.nodes = { [group.id]: group, [child.id]: child }
  plain.pages[0].children = [group.id]
  expect((await pngOf(plain, group.id, 2)).size).toEqual({ width: 83, height: 58 })
  const slice = await exportImage(plain, plain.pages[0].id, 'png', 1, undefined, undefined, {
    kind: 'slice', bounds: { x: -4.5, y: 2.25, width: 12.25, height: 9.5 },
  })
  expect(pngSize(new Uint8Array(await slice.blob.arrayBuffer()))).toEqual({ width: 13, height: 10 })
}, 120_000)

test('both interface layouts export the snapped group PNG from the layer control', async () => {
  vi.stubGlobal('Worker', CpuWorker)
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const blobs: Blob[] = []
  const urlApi = URL as typeof URL & { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void }
  const previousCreate = urlApi.createObjectURL?.bind(urlApi)
  const previousRevoke = urlApi.revokeObjectURL?.bind(urlApi)
  const remember = (blob: Blob) => {
    blobs.push(blob)
    return `blob:measure/${blobs.length}`
  }
  urlApi.createObjectURL = remember
  urlApi.revokeObjectURL = () => {}
  dom.window.URL.createObjectURL = remember
  dom.window.URL.revokeObjectURL = () => {}
  const rows = [
    { origin: { x: 0, y: 0 }, scale: 2, width: 84, height: 58 },
    { origin: { x: 2.5, y: -1.5 }, scale: 1, width: 42, height: 30 },
    { origin: { x: 2.5, y: -1.5 }, scale: 2, width: 84, height: 60 },
    { origin: { x: -112.25, y: 90.15 }, scale: 2, width: 84, height: 58 },
    { origin: { x: 2.5, y: -1.5 }, scale: 0.5, width: 21, height: 15 },
    { origin: { x: 8, y: 5 }, scale: 2, width: 84, height: 58 },
  ]
  let root: Root | undefined
  try {
    root = createRoot(dom.window.document.getElementById('mount')!)
    for (const row of rows) {
      const { doc, group } = imported(row.origin)
      const { validateDocument } = await import('./model')
      validateDocument(structuredClone(doc))
      const editor = new Editor(doc)
      editors.push(editor)
      editor.update([group.id], { exportSettings: [{ id: uid(), format: 'png', scale: row.scale, suffix: '' }] }, '修改图层导出设置')
      expect(editor.state.doc.nodes[group.id].exportSettings?.[0].scale, editor.state.message).toBe(row.scale)
      const direct = await pngOf(editor.state.doc, group.id, row.scale)
      const hashes: string[] = []
      for (const uiMode of ['figma', 'sketch'] as const) {
        interfacePreference.set({ uiMode, locale: 'zh-CN' })
        expect(interfacePreference.getSnapshot().uiMode).toBe(uiMode)
        blobs.length = 0
        regionRequests.length = 0
        const Live = () => React.createElement(NodeExportPanel, { editor, node: editor.state.doc.nodes[group.id] })
        await act(async () => { root!.render(React.createElement(Live)) })
        const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === '预览并导出此图层')
        expect(button, uiMode).toBeTruthy()
        await act(async () => {
          button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          for (let attempt = 0; attempt < 100 && blobs.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
        })
        const status = dom.window.document.querySelector('[role="status"]')?.textContent ?? ''
        expect(status, `${uiMode} ${row.origin.x},${row.origin.y} @${row.scale}`).toContain('已生成')
        const bytes = new Uint8Array(await blobs[0].arrayBuffer())
        expect(pngSize(bytes)).toEqual({ width: row.width, height: row.height })
        expect(sha(bytes)).toBe(direct.hash)
        const sent = regionRequests.at(-1)?.options.exportRegion?.bounds
        expect(sent).toEqual(rasterExportBounds(editor.state.doc, editor.state.page, { kind: 'selection', nodeIds: [group.id] }))
        hashes.push(sha(bytes))
      }
      expect(hashes[0]).toBe(hashes[1])
      await act(async () => { root!.render(null) })
    }
  } finally {
    if (root) await act(async () => root.unmount())
    if (previousCreate) urlApi.createObjectURL = previousCreate
    if (previousRevoke) urlApi.revokeObjectURL = previousRevoke
    dom.window.close()
  }
}, 120_000)
