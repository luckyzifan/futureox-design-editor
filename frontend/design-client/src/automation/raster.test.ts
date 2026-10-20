import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { unzlibSync } from 'fflate'
import { blank, node } from '../model'
import { initializePicking } from '../kernel/picking'
import type { KernelOptions } from '../kernel/client'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { captureRaster } from './raster'
import { Editor } from '../engine'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport } from './bridge'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
import { PassThrough } from 'node:stream'
type Request = {
  id: number
  document?: string
  options: KernelOptions
  png: boolean
  backend: string
}
const requests: Request[] = []
const workers: CpuWorker[] = []
let held = false
class CpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor() {
    workers.push(this)
  }
  postMessage(request: Request) {
    requests.push(request)
    if (held) return
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const bytes = this.engine.render_region_png(
          JSON.stringify({
            pageId: request.options.pageId,
            ...request.options.exportRegion,
            rasterProfile: request.options.rasterProfile,
            colorOutput: request.options.colorOutput,
          }),
        )
        this.onmessage?.({
          data: {
            id: request.id,
            buffer: bytes.buffer,
            stats: JSON.parse(this.engine.stats()),
            backend: 'cpu',
          },
        })
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
beforeAll(async () =>
  initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  }),
)
afterEach(() => {
  vi.unstubAllGlobals()
  workers.splice(0)
  requests.splice(0)
  held = false
})
function installWorker() {
  vi.stubGlobal('Worker', CpuWorker)
  vi.stubGlobal('localStorage', { getItem: () => 'webgpu' })
}
function fixture() {
  const doc = blank(),
    frame = node('frame', -12.375, 7.125, 24, 24)
  frame.name = 'Icon'
  frame.fills[0].color = '#ff0000'
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  return { doc, frame, page: doc.pages[0].id }
}
async function dimensions(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer())
  return [view.getUint32(16), view.getUint32(20)]
}

function decode(blob: Blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer), width = view.getUint32(16), height = view.getUint32(20)
    expect(bytes[24]).toBe(8); expect(bytes[25]).toBe(6)
    const chunks: Uint8Array[] = []
    for (let at = 8; at < bytes.length;) { const n = view.getUint32(at); if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + n)); at += n + 12 }
    const encoded = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let at = 0
    for (const chunk of chunks) { encoded.set(chunk, at); at += chunk.length }
    const raw = unzlibSync(encoded), pixels = new Uint8Array(width * height * 4), stride = width * 4
    const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
    for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
      const filter = raw[y * (stride + 1)], i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0
      pixels[i] = raw[y * (stride + 1) + x + 1] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c))
    }
    return { width, height, pixels }
  })
}
test('real CPU PNG export preserves exact 1x/2x/3x/custom dimensions, transparent corners and authored fill pixels', async () => {
  installWorker()
  const { doc, frame, page } = fixture()
  frame.kind = 'ellipse'
  const before = JSON.stringify(doc)
  const result = await captureRaster(doc, { pageId: page, nodeIds: [frame.id], scales: [1, 2, 3, 1.5] }, new AbortController().signal)
  const decoded = await Promise.all(result.assets.map(a => decode(a.blob)))
  expect(decoded.map(p => [p.width, p.height])).toEqual([[24,24],[48,48],[72,72],[36,36]])
  for (const png of decoded) {
    expect([...png.pixels.subarray(0, 4)]).toEqual([0,0,0,0])
    const center = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4
    expect([...png.pixels.subarray(center, center + 4)]).toEqual([255,0,0,255])
  }
  expect(JSON.stringify(doc)).toBe(before)
  expect(workers).toHaveLength(1); expect(workers[0].terminated).toBe(true)
  const evidence = new URL('../../../../evidence/phase/png-export/', import.meta.url)
  await mkdir(evidence, { recursive: true })
  for (const a of result.assets) await writeFile(new URL(`mcp-real-cpu-${a.scale}x.png`, evidence), new Uint8Array(await a.blob.arrayBuffer()))
  await writeFile(new URL('raster-pixel-report.json', evidence), JSON.stringify({ renderer: 'actual Rust WASM CPU via in-process Worker adapter', dimensions: decoded.map(p => [p.width,p.height]), transparentCorner: [0,0,0,0], center: [255,0,0,255], gpuEquivalent: false }, null, 2))
})
test('page and authored slice share exact bounds; oversized and foreign targets allocate no workers', async () => {
  installWorker()
  const { doc, frame, page } = fixture()
  const slice = node('slice', -12.375, 7.125, 12.25, 9.5)
  doc.schemaVersion = 10; slice.fills = []; slice.strokes = []; slice.effects = []; doc.nodes[slice.id] = slice; doc.pages[0].children.push(slice.id)
  expect(await dimensions((await captureRaster(doc, { pageId: page, sliceId: slice.id, scales: [3] }, new AbortController().signal)).assets[0].blob)).toEqual([37,29])
  expect(await dimensions((await captureRaster(doc, { pageId: page, padding: 0 }, new AbortController().signal)).assets[0].blob)).toEqual([24,24])
  const count = workers.length
  frame.width = 2200; frame.height = 2200
  await expect(captureRaster(doc, { pageId: page, nodeIds: [frame.id], scales: [1,2,3] }, new AbortController().signal)).rejects.toThrow('64 MP')
  frame.width = 20000
  await expect(captureRaster(doc, { pageId: page, nodeIds: [frame.id] }, new AbortController().signal)).rejects.toThrow('16384')
  await expect(captureRaster(doc, { pageId: 'foreign', sliceId: slice.id }, new AbortController().signal)).rejects.toThrow()
  expect(workers).toHaveLength(count)
})

test('real MCP tool catalog exports and reconstructs exact CPU PNG artifacts through the mounted bridge', async () => {
  installWorker()
  const { doc, frame, page } = fixture(), editor = new Editor(doc)
  let receive: (request: DesktopAutomationRequest) => void = () => {}, methods: any[] = [], serial = 0
  const pending = new Map<string, (result: any) => void>()
  const transport = {
    register: async (value: any) => { methods = value?.methods ?? [] },
    respond: async (value: any) => { pending.get(value.requestId)?.(value.result) },
    recordEdit: async () => ({ accepted: true }),
    onRequest: (cb: typeof receive) => { receive = cb; return () => {} }, onCancel: () => () => {},
  } as unknown as DesktopAutomationTransport
  const dispose = attachDesktopAutomation(editor, transport)
  const backend = new OperationBackend({ capabilities: { version: 1, methods }, scope: 'read', target: { documentId: doc.id, session: editor.sessionGeneration }, execute: (request: any) => new Promise(resolve => {
    const requestId = `mcp-raster-${++serial}`; pending.set(requestId, resolve)
    receive({ requestId, kind: 'execute', sessionId: 'mcp-raster-session', scope: 'read', documentId: doc.id, session: editor.sessionGeneration, deadline: Date.now() + 15000, request })
  }) })
  const server = new DesignMcpServer({ backend, input: new PassThrough(), output: new PassThrough(), diagnostics: new PassThrough() }) as unknown as { callTool(params: unknown, context: unknown): Promise<any>; close(): Promise<void> }
  const context = { signal: new AbortController().signal }
  try {
    expect(backend.listTools().some((tool: any) => tool.name === 'design_raster_export' && tool.annotations.readOnlyHint)).toBe(true)
    const result = await server.callTool({ name: 'design_raster_export', arguments: { params: { pageId: page, nodeIds: [frame.id], scales: [1, 2, 3] } } }, context)
    expect(result.isError).toBe(false)
    const dimensions: number[][] = []
    for (const file of result.structuredContent.result.files) {
      const parts: Uint8Array[] = []; let offset = 0
      while (offset < file.bytes) {
        const read = await server.callTool({ name: 'design_raster_read', arguments: { params: { artifactId: file.artifactId, offset, length: 73 } } }, context)
        expect(read.isError).toBe(false)
        const chunk = read.structuredContent.result
        parts.push(Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0))); offset = chunk.nextOffset
      }
      const png = await decode(new Blob(parts.map(part => new Uint8Array(part).buffer))); dimensions.push([png.width, png.height])
      expect(await server.callTool({ name: 'design_raster_release', arguments: { params: { artifactId: file.artifactId } } }, context)).toMatchObject({ isError: false })
    }
    expect(dimensions).toEqual([[24,24],[48,48],[72,72]])
    const path = new URL('../../../../evidence/phase/png-export/mcp-raster-report.json', import.meta.url)
    await mkdir(new URL('.', path), { recursive: true })
    await writeFile(path, JSON.stringify({ path: 'DesignMcpServer -> OperationBackend -> mounted editor bridge -> shared exporter -> actual Rust WASM CPU -> bounded byte chunks -> PNG decode', dimensions, realSocket: false, renderer: 'cpu' }, null, 2))
  } finally { dispose(); editor.dispose(); await server.close() }
})
