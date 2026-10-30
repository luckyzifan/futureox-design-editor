import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { blank, node } from './model'
import { exportImage, exportPngBatch, targetBounds } from './export'
import { initializePicking, kernelExportPlan } from './kernel/picking'
import type { KernelOptions } from './kernel/client'
import { VectorEngine } from './generated/design-kernel/design_kernel'

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
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
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
test('exact selection and explicit page padding are independent targets', () => {
  const { doc, frame, page } = fixture()
  expect(targetBounds(doc, page, { kind: 'selection', nodeIds: [frame.id] })).toEqual({
    x: -12.375,
    y: 7.125,
    width: 24,
    height: 24,
  })
  expect(targetBounds(doc, page, { kind: 'page', padding: 0 }).width).toBe(24)
  expect(targetBounds(doc, page, { kind: 'page' }).width).toBe(104)
  expect(() => targetBounds(doc, page, { kind: 'selection', nodeIds: ['missing'] })).toThrow()
})
test('Rust export planning never reads device DPR or editor zoom', () => {
  for (const dpr of [1, 2, 3]) {
    vi.stubGlobal('devicePixelRatio', dpr)
    for (const scale of [1, 2, 3]) {
      expect(kernelExportPlan({ x: -12.375, y: 7.125, width: 24, height: 24 }, scale)).toEqual({
        width: 24 * scale,
        height: 24 * scale,
        view: { x: 12.375 * scale, y: -7.125 * scale, zoom: scale },
      })
    }
  }
})
test('batch uses one real CPU Engine and stable 1x/2x/3x dimensions and filenames', async () => {
  installWorker()
  const { doc, frame, page } = fixture()
  const before = JSON.stringify(doc)
  const assets = await exportPngBatch(doc, page, [1, 2, 3], {
    kind: 'selection',
    nodeIds: [frame.id],
  })
  expect(workers).toHaveLength(1)
  expect(workers[0].terminated).toBe(true)
  expect(requests.every((request) => request.backend === 'cpu' && request.png)).toBe(true)
  expect(requests.filter((request) => request.document !== undefined)).toHaveLength(1)
  expect(await Promise.all(assets.map((asset) => dimensions(asset.blob)))).toEqual([
    [24, 24],
    [48, 48],
    [72, 72],
  ])
  expect(assets.map((asset) => asset.name)).toEqual(
    [1, 2, 3].map((scale) => `${doc.name}-Icon@${scale}x.png`),
  )
  expect(JSON.stringify(doc)).toBe(before)
})
test('existing whole-page PNG remains 2x with explicit 40-unit presentation margin', async () => {
  installWorker()
  const { doc, page } = fixture()
  const asset = await exportImage(doc, page, 'png')
  expect(await dimensions(asset.blob)).toEqual([208, 208])
  expect(requests[0].backend).toBe('cpu')
})
test('fractional manual slices preserve origin and never stretch to fit rounded dimensions', async () => {
  installWorker()
  const { doc, page } = fixture()
  const bounds = { x: -12.375, y: 7.125, width: 12.25, height: 9.5 }
  const assets = await exportPngBatch(doc, page, [1, 2, 3], { kind: 'slice', bounds })
  expect(await Promise.all(assets.map((asset) => dimensions(asset.blob)))).toEqual([
    [13, 10],
    [25, 19],
    [37, 29],
  ])
  expect(requests.map((request) => request.options.view.zoom)).toEqual([1, 2, 3])
  expect(
    requests.every(
      (request) => JSON.stringify(request.options.exportRegion?.bounds) === JSON.stringify(bounds),
    ),
  ).toBe(true)
})
test('invalid and aggregate over-budget requests allocate no workers', async () => {
  installWorker()
  const { doc, page } = fixture()
  for (const scales of [[], [1, 1], [NaN], [0], [129]]) {
    await expect(exportPngBatch(doc, page, scales)).rejects.toThrow()
  }
  await expect(
    exportPngBatch(doc, page, [1, 2, 3], {
      kind: 'slice',
      bounds: { x: 0, y: 0, width: 2200, height: 2200 },
    }),
  ).rejects.toThrow('批量')
  expect(workers).toHaveLength(0)
})
test('cancelled and failed requests dispose their worker; a new request can succeed', async () => {
  installWorker()
  const { doc, page } = fixture()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    exportPngBatch(doc, page, [1], { kind: 'page' }, undefined, cancelled.signal),
  ).rejects.toThrow('取消')
  expect(workers).toHaveLength(0)
  held = true
  const pending = new AbortController()
  const attempt = exportPngBatch(doc, page, [1], { kind: 'page' }, undefined, pending.signal)
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  pending.abort()
  await expect(attempt).rejects.toThrow()
  expect(workers[0].terminated).toBe(true)
  held = false
  await expect(
    exportPngBatch(doc, page, [1], { kind: 'page' }, { space: 'srgb', toneMap: 'clip' }),
  ).rejects.toThrow('managed')
  expect(workers[1].terminated).toBe(true)
  expect(await exportPngBatch(doc, page, [1])).toHaveLength(1)
  expect(workers[2].terminated).toBe(true)
})
