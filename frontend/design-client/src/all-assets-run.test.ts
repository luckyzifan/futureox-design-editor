import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { afterEach, expect, test, vi } from 'vitest'
import { ALL_ASSETS_BUDGET_REASON, ALL_ASSETS_CANCEL_REASON, ALL_ASSETS_CONFLICT_REASON, planAllAssets } from './all-assets-plan'
import { allAssetsManifest, allAssetsStatusText, allAssetsZip, encodeAllAssetTask, mergeAllAssetRuns, runAllAssets, sha256Hex, type AllAssetEncoder } from './all-assets-run'
import { defaultColorSettings } from './color'
import type { KernelOptions } from './kernel/client'
import { VectorEngine, transcode_export_png } from './generated/design-kernel/design_kernel'
import { blank, node, paint } from './model'

function issueFixture() {
  const doc = blank('assets')
  doc.schemaVersion = 10
  const rect = node('rectangle', 0, 0, 40, 30)
  const ellipse = node('ellipse', 80, 10, 20, 16)
  rect.name = '矩形'
  ellipse.name = '椭圆'
  rect.fills = [paint('#e11d48')]
  ellipse.fills = [paint('#2563eb')]
  rect.exportSettings = [
    { id: 'rect-png', format: 'png', scale: 1, suffix: '@one' },
    { id: 'rect-svg', format: 'svg', scale: 1, suffix: '@vector' },
  ]
  ellipse.exportSettings = [
    { id: 'ell-png', format: 'png', scale: 1, suffix: '@one' },
    { id: 'ell-svg', format: 'svg', scale: 1, suffix: '@vector' },
  ]
  doc.nodes = { [rect.id]: rect, [ellipse.id]: ellipse }
  doc.pages[0].children = [rect.id, ellipse.id]
  return { doc, rect, ellipse, pageId: doc.pages[0].id }
}

class ExportCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor() {
    this.engine.load_font(new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))))
  }
  postMessage(request: { id: number; document?: string; options?: KernelOptions; png?: boolean; command?: string }) {
    queueMicrotask(() => {
      if (this.terminated || request.command || !request.options) return
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

afterEach(() => { vi.unstubAllGlobals() })

function pngSize(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

test('the same two-layer preset target delivers four separate files, not one merged selection', async () => {
  vi.stubGlobal('Worker', ExportCpuWorker)
  const { doc, rect, ellipse, pageId } = issueFixture()
  const saved = JSON.stringify(doc)
  const plan = planAllAssets(doc, { scope: 'page', pageId, revision: 3 })
  const run = await runAllAssets({ document: doc, plan, selectedIds: new Set(plan.tasks.map(task => task.id)), encoding: '' })
  expect(JSON.stringify(doc)).toBe(saved)
  expect(run.complete).toBe(true)
  expect(run.counts).toEqual({ selected: 4, delivered: 4, failed: 0, cancelled: 0, conflict: 0, blocked: 0 })
  expect(allAssetsStatusText(run, false)).toBe('已导出 4 个文件')
  const byPath = new Map(run.items.map(item => [item.task.path, item]))
  const rectPng = byPath.get('矩形@one.png')!
  const ellipsePng = byPath.get('椭圆@one.png')!
  const rectSvg = new TextDecoder().decode(byPath.get('矩形@vector.svg')!.bytes)
  const ellipseSvg = new TextDecoder().decode(byPath.get('椭圆@vector.svg')!.bytes)
  expect(pngSize(rectPng.bytes!)).toEqual({ width: 40, height: 30 })
  expect(pngSize(ellipsePng.bytes!)).toEqual({ width: 20, height: 16 })
  expect(rectPng.sha256).not.toBe(ellipsePng.sha256)
  expect(rectSvg).toContain('#e11d48')
  expect(rectSvg).not.toContain('#2563eb')
  expect(ellipseSvg).toContain('#2563eb')
  expect(ellipseSvg).not.toContain('#e11d48')
  expect(rectPng.task).toMatchObject({ nodeId: rect.id, revision: 3, format: 'png', scale: 1, suffix: '@one' })
  expect(ellipseSvg && byPath.get('椭圆@vector.svg')!.task.nodeId).toBe(ellipse.id)
  const files = unzipSync(allAssetsZip(run))
  expect(Object.keys(files).sort()).toEqual(['manifest.json', '椭圆@one.png', '椭圆@vector.svg', '矩形@one.png', '矩形@vector.svg'].sort())
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
  expect(manifest).toMatchObject({ kind: 'futureox-all-assets', version: 1, complete: true, revision: 3, counts: run.counts })
  expect(manifest.items).toHaveLength(4)
  for (const item of manifest.items) {
    expect(item.sha256).toBe(await sha256Hex(files[item.path]))
    expect(files[item.path].byteLength).toBe(item.bytes)
    expect(item.nodeId).toBe(byPath.get(item.path)!.task.nodeId)
  }
  expect(allAssetsManifest(run).complete).toBe(true)
})

test('name collisions, the pixel budget, cancellation, failure and retry stay per item', async () => {
  const doc = blank('batch')
  doc.schemaVersion = 10
  const left = node('rectangle', 0, 0, 8, 8)
  const right = node('rectangle', 20, 0, 8, 8)
  const other = node('ellipse', 40, 0, 8, 8)
  const round = node('rectangle', 60, 0, 8, 8)
  left.name = 'Icon'
  right.name = 'icon'
  other.name = 'Other'
  round.name = 'Round'
  for (const shape of [left, right, other]) shape.exportSettings = [{ id: shape.id, format: 'svg', scale: 1, suffix: '@one' }]
  round.exportSettings = [{ id: 'eps', format: 'eps', scale: 1, suffix: '@one' }]
  doc.nodes = Object.fromEntries([left, right, other, round].map(shape => [shape.id, shape]))
  doc.pages[0].children = [left.id, right.id, other.id, round.id]
  const plan = planAllAssets(doc, { scope: 'page', pageId: doc.pages[0].id, revision: 2 })
  const calls: string[] = []
  const encode: AllAssetEncoder = async task => {
    calls.push(task.nodeId)
    if (task.nodeName === 'Other' && calls.filter(id => id === task.nodeId).length === 1) throw new Error('svg failed')
    return { bytes: new TextEncoder().encode(task.path) }
  }
  const selected = new Set(plan.tasks.map(task => task.id))
  const run = await runAllAssets({ document: doc, plan, selectedIds: selected, encoding: '', encode })
  expect(run.complete).toBe(false)
  expect(run.counts.conflict).toBe(2)
  expect(run.counts.failed).toBe(1)
  expect(run.counts.blocked).toBe(1)
  expect(run.counts.delivered).toBe(0)
  expect(calls).toEqual([other.id])
  expect(run.items.filter(item => item.status === 'conflict').map(item => item.message)).toEqual([ALL_ASSETS_CONFLICT_REASON, ALL_ASSETS_CONFLICT_REASON])
  expect(allAssetsStatusText(run, false)).toContain('未交付')
  expect(allAssetsStatusText(run, false)).not.toBe('已导出 4 个文件')
  const retried = await runAllAssets({
    document: doc,
    plan,
    selectedIds: new Set(run.items.filter(item => item.status === 'failed').map(item => item.task.id)),
    encoding: '',
    encode,
  })
  const merged = mergeAllAssetRuns(run, retried)
  expect(merged.counts.failed).toBe(0)
  expect(merged.counts.delivered).toBe(1)
  expect(merged.complete).toBe(false)
  const zip = unzipSync(allAssetsZip(merged))
  expect(Object.keys(zip).sort()).toEqual(['Other@one.svg', 'manifest.json'])
  expect(JSON.parse(new TextDecoder().decode(zip['manifest.json'])).complete).toBe(false)

  const controller = new AbortController()
  let started = 0
  const cancellable: AllAssetEncoder = async (task, _document, signal) => {
    started += 1
    if (started === 2) controller.abort()
    if (signal.aborted) throw new Error('已取消导出')
    return { bytes: new TextEncoder().encode(task.nodeId) }
  }
  const onlyOther = planAllAssets(doc, { scope: 'page', pageId: doc.pages[0].id, revision: 2 })
  const cancelPlan = {
    ...onlyOther,
    tasks: [left, right, other].map((shape, index) => ({
      ...onlyOther.tasks.find(task => task.nodeId === other.id)!,
      id: `cancel-${index}`,
      nodeId: shape.id,
      nodeName: shape.name,
      path: `${shape.name}-${index}.svg`,
      executable: true,
      pixelCount: 0,
    })),
  }
  const cancelled = await runAllAssets({ document: doc, plan: cancelPlan, selectedIds: new Set(cancelPlan.tasks.map(task => task.id)), encoding: '', signal: controller.signal, encode: cancellable })
  expect(cancelled.items.map(item => item.status)).toEqual(['delivered', 'cancelled', 'cancelled'])
  expect(cancelled.complete).toBe(false)
  expect(allAssetsStatusText(cancelled, true)).toContain('not delivered 2')
  expect(cancelled.items[1].message).toBe(ALL_ASSETS_CANCEL_REASON)

  const hugeA = node('rectangle', 0, 0, 3000, 3000)
  const hugeB = node('rectangle', 0, 0, 3000, 3000)
  hugeA.exportSettings = [{ id: 'a', format: 'png', scale: 2, suffix: '@a' }]
  hugeB.exportSettings = [{ id: 'b', format: 'png', scale: 2, suffix: '@b' }]
  const budgetDoc = blank('budget')
  budgetDoc.schemaVersion = 10
  budgetDoc.nodes = { [hugeA.id]: hugeA, [hugeB.id]: hugeB }
  budgetDoc.pages[0].children = [hugeA.id, hugeB.id]
  const budgetPlan = planAllAssets(budgetDoc, { scope: 'page', pageId: budgetDoc.pages[0].id, revision: 1 })
  expect(budgetPlan.tasks.reduce((sum, task) => sum + task.pixelCount, 0)).toBeGreaterThan(64_000_000)
  let budgetCalls = 0
  const blocked = await runAllAssets({
    document: budgetDoc,
    plan: budgetPlan,
    selectedIds: new Set(budgetPlan.tasks.map(task => task.id)),
    encoding: '',
    encode: async () => { budgetCalls += 1; return { bytes: new Uint8Array([1]) } },
  })
  expect(budgetCalls).toBe(0)
  expect(blocked.complete).toBe(false)
  expect(blocked.items.every(item => item.status === 'blocked' && item.message === ALL_ASSETS_BUDGET_REASON)).toBe(true)
  expect(allAssetsStatusText(blocked, false)).toContain('未交付 2')
})

test('wide-gamut presets fail individually and do not clip the batch into a success', async () => {
  vi.stubGlobal('Worker', ExportCpuWorker)
  const doc = blank('color')
  doc.schemaVersion = 10
  doc.colorManagement = defaultColorSettings()
  doc.rasterProfile = 'figma'
  const plain = node('rectangle', 0, 0, 12, 10)
  const wide = node('rectangle', 20, 0, 12, 10)
  plain.name = 'Plain'
  wide.name = 'Wide'
  plain.fills = [paint('#112233')]
  wide.fills = [paint('#112233')]
  wide.fills[0].color = 'color(srgb 1.4 0 0)'
  plain.exportSettings = [{ id: 'plain', format: 'png', scale: 1, suffix: '@one' }]
  wide.exportSettings = [{ id: 'wide', format: 'png', scale: 1, suffix: '@wide' }]
  doc.nodes = { [plain.id]: plain, [wide.id]: wide }
  doc.pages[0].children = [plain.id, wide.id]
  const plan = planAllAssets(doc, { scope: 'page', pageId: doc.pages[0].id, revision: 5 })
  const run = await runAllAssets({ document: doc, plan, selectedIds: new Set(plan.tasks.map(task => task.id)), encoding: '' })
  expect(run.complete).toBe(false)
  expect(run.items.find(item => item.task.nodeId === plain.id)?.status).toBe('delivered')
  expect(run.items.find(item => item.task.nodeId === wide.id)?.message).toContain('不会静默裁成 8 位')
  expect(allAssetsStatusText(run, false)).toContain('未交付')
  expect(allAssetsStatusText(run, false)).not.toContain('已导出 2 个文件')
  const chosen = await encodeAllAssetTask(plan.tasks.find(task => task.nodeId === wide.id)!, doc, new AbortController().signal, 'srgb')
  expect(chosen.bytes.byteLength).toBeGreaterThan(8)
})
