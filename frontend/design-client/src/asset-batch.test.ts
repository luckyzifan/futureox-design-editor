import { unzipSync } from 'fflate'
import { expect, test, vi } from 'vitest'
import {
  ASSET_BUDGET_ERROR,
  ASSET_MISMATCH_ERROR,
  ASSET_ROUNDTRIP_ERROR,
  assetBatchSummary,
  assetBatchZip,
  assetFileName,
  assetManifest,
  enumerateAssetTasks,
  filterAssetTasks,
  mergeAssetStates,
  runAssetBatch,
} from './asset-batch'
import { exportImage, filename } from './export'
import { Editor } from './engine'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, uid, type DesignDocument, type ExportSetting } from './model'

function preset(format: ExportSetting['format'], suffix: string, scale = 1): ExportSetting {
  return { id: uid(), format, scale, suffix }
}

function twoLayers() {
  const doc = blank('Assets')
  doc.schemaVersion = 8
  const rect = node('rectangle', 0, 0, 40, 24)
  const ellipse = node('ellipse', 80, 0, 36, 28)
  rect.name = 'Rect'
  ellipse.name = 'Ellipse'
  rect.exportSettings = [preset('png', '@one'), preset('svg', '@vector')]
  ellipse.exportSettings = [preset('png', '@one'), preset('svg', '@vector')]
  const nested = node('rectangle', 4, 4, 8, 8)
  nested.name = 'Nested'
  nested.exportSettings = [preset('png', '@one')]
  const group = node('group', 0, 80, 20, 20)
  group.name = 'Group'
  group.children = [nested.id]
  const hidden = node('rectangle', 0, 140, 12, 12)
  hidden.name = 'Hidden'
  hidden.visible = false
  hidden.exportSettings = [preset('png', '@one')]
  const other = node('ellipse', 0, 0, 10, 10)
  other.name = 'Other page'
  other.exportSettings = [preset('svg', '@vector')]
  const page2 = { id: uid(), name: '页面 2', children: [other.id], background: '#ffffff' }
  doc.pages.push(page2)
  doc.nodes = Object.fromEntries([rect, ellipse, group, nested, hidden, other].map(item => [item.id, item]))
  doc.pages[0].children = [rect.id, ellipse.id, group.id, hidden.id]
  return { doc, rect, ellipse, nested, hidden, other }
}

function tasksOf(doc: DesignDocument) {
  return enumerateAssetTasks(doc, doc.pages[0].id, 3)
}

test('enumeration lists each current-page preset and does not read other pages or mutate the document', () => {
  const { doc, rect, ellipse, nested, hidden, other } = twoLayers()
  const before = JSON.stringify(doc)
  const tasks = tasksOf(doc)
  expect(JSON.stringify(doc)).toBe(before)
  expect(tasks.map(task => task.path)).toEqual([
    'Rect@one.png', 'Rect@vector.svg', 'Ellipse@one.png', 'Ellipse@vector.svg', 'Nested@one.png', 'Hidden@one.png',
  ])
  expect(tasks.every(task => task.revision === 3 && task.documentId === doc.id && task.pageId === doc.pages[0].id)).toBe(true)
  expect(tasks.find(task => task.nodeId === rect.id && task.format === 'png')).toMatchObject({ scale: 1, suffix: '@one', executable: true })
  expect(tasks.some(task => task.nodeId === other.id)).toBe(false)
  expect(filterAssetTasks(tasks, { layer: 'ell' }).map(task => task.nodeId)).toEqual([ellipse.id, ellipse.id])
  expect(filterAssetTasks(tasks, { format: 'svg' }).map(task => task.path)).toEqual(['Rect@vector.svg', 'Ellipse@vector.svg'])
  expect(filterAssetTasks(tasks, { scale: '2' })).toEqual([])
  expect(assetFileName('Rect', { format: 'png', scale: 1, suffix: '@one' })).toBe(`${filename('Rect@one')}.png`)
  expect(tasks.find(task => task.nodeId === nested.id)?.path).toBe('Nested@one.png')
  expect(tasks.find(task => task.nodeId === hidden.id)?.executable).toBe(true)
})

test('round-trip formats, name collisions and stale presets fail per item and are not a completed batch', async () => {
  const { doc, rect } = twoLayers()
  const tiff = preset('tiff', '@one')
  rect.exportSettings = [...rect.exportSettings!, tiff]
  const tasks = tasksOf(doc)
  const blocked = tasks.find(task => task.settingId === tiff.id)!
  expect(blocked.executable).toBe(false)
  expect(blocked.blockReason).toBe(ASSET_ROUNDTRIP_ERROR)
  const duplicate = tasks.find(task => task.nodeId === rect.id && task.format === 'png')!
  const copy = { ...duplicate, id: `${duplicate.id}-copy` }
  const calls: string[] = []
  const collided = await runAssetBatch({
    document: doc, pageId: doc.pages[0].id, revision: 3, tasks: [duplicate, copy, blocked], encoding: '',
    signal: new AbortController().signal,
    exportImage: async () => { calls.push('export'); throw new Error('should not export') },
  })
  expect(calls).toEqual([])
  expect(collided.files).toEqual([])
  expect(collided.manifest.complete).toBe(false)
  expect(collided.manifest.fileCount).toBe(0)
  expect(collided.manifest.tasks.map(task => task.status)).toEqual(['failed', 'failed', 'failed'])
  expect(collided.manifest.tasks[0].error).toContain('冲突')
  expect(collided.manifest.tasks[2].error).toBe(ASSET_ROUNDTRIP_ERROR)
  expect(assetBatchSummary(collided.manifest)).toContain('未完成')
  expect(assetBatchSummary(collided.manifest)).not.toContain('已完成')
  const stale = { ...duplicate, scale: 4 }
  const mismatched = await runAssetBatch({
    document: doc, pageId: doc.pages[0].id, revision: 3, tasks: [stale], encoding: '',
    signal: new AbortController().signal,
    exportImage: async () => { throw new Error('should not export') },
  })
  expect(mismatched.manifest.tasks[0]).toMatchObject({ status: 'failed', error: ASSET_MISMATCH_ERROR })
  expect(mismatched.manifest.complete).toBe(false)
})

test('pixel budget and cancellation stop before claiming the batch is complete', async () => {
  const doc = blank('Budget')
  doc.schemaVersion = 8
  const shape = node('rectangle', 0, 0, 7000, 5000)
  shape.name = 'Huge'
  shape.exportSettings = [preset('png', '@one'), preset('png', '@two'), preset('svg', '@vector')]
  doc.nodes = { [shape.id]: shape }
  doc.pages[0].children = [shape.id]
  const tasks = enumerateAssetTasks(doc, doc.pages[0].id, 1)
  let rendered = 0
  const over = await runAssetBatch({
    document: doc, pageId: doc.pages[0].id, revision: 1, tasks, encoding: '',
    signal: new AbortController().signal,
    exportImage: async () => { rendered += 1; throw new Error('rendered') },
  })
  expect(rendered).toBe(0)
  expect(over.files).toEqual([])
  expect(over.manifest.complete).toBe(false)
  expect(over.manifest.tasks.every(task => task.status === 'failed' && task.error === ASSET_BUDGET_ERROR)).toBe(true)
  expect(assetBatchSummary(over.manifest, 'en')).toMatch(/^Not complete:/)

  const { doc: small } = twoLayers()
  const svgTasks = tasksOf(small).filter(task => task.format === 'svg')
  const controller = new AbortController()
  let started = 0
  const cancelled = await runAssetBatch({
    document: small, pageId: small.pages[0].id, revision: 3, tasks: svgTasks, encoding: '',
    signal: controller.signal,
    exportImage: async () => {
      started += 1
      if (started === 1) return { blob: new Blob(['<svg id="one"></svg>']), width: 1, height: 1 }
      controller.abort()
      throw new Error('已取消导出')
    },
  })
  expect(cancelled.manifest.complete).toBe(false)
  expect(cancelled.manifest.fileCount).toBe(1)
  expect(cancelled.manifest.tasks.map(task => task.status)).toEqual(['succeeded', 'cancelled'])
  expect(assetBatchSummary(cancelled.manifest)).toBe('未完成：1 个成功，0 个失败，1 个已取消。')
  const retried = mergeAssetStates(svgTasks, cancelled.manifest.tasks, cancelled.manifest.tasks.map(task => task.status === 'cancelled' ? { ...task, status: 'succeeded', byteLength: 1 } : task))
  expect(assetManifest({ documentId: small.id, pageId: small.pages[0].id, revision: 3, tasks: retried }).complete).toBe(true)
})

class CpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  postMessage(request: { id: number; document?: string; options: { pageId?: string; exportRegion?: unknown; rasterProfile?: string; colorOutput?: unknown }; png?: boolean }) {
    queueMicrotask(() => {
      if (this.terminated) return
      try {
        if (request.document) this.engine.load_document(request.document)
        const bytes = this.engine.render_region_png(JSON.stringify({
          pageId: request.options.pageId,
          ...request.options.exportRegion as object,
          rasterProfile: request.options.rasterProfile,
          colorOutput: request.options.colorOutput,
        }))
        this.onmessage?.({ data: { id: request.id, buffer: bytes.buffer, stats: JSON.parse(this.engine.stats()), backend: 'cpu' } })
      } catch (error) {
        this.onmessage?.({ data: { id: request.id, error: String(error) } })
      }
    })
  }
  terminate() {
    if (!this.terminated) { this.terminated = true; this.engine.free() }
  }
}

test('two root presets export four real files while merged selection stays one image', async () => {
  vi.stubGlobal('Worker', CpuWorker)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  const { doc, rect, ellipse } = twoLayers()
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const json = JSON.stringify(before)
    const page = editor.state.page
    const listed = enumerateAssetTasks(before, page, editor.state.version)
    const selected = listed.filter(task => task.nodeId === rect.id || task.nodeId === ellipse.id)
    expect(selected).toHaveLength(4)
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    const merged = await exportImage(before, page, 'png', 1, undefined, undefined, { kind: 'selection', nodeIds: [rect.id, ellipse.id] })
    const mergedBytes = new Uint8Array(await merged.blob.arrayBuffer())
    expect(merged.name).toContain('selection')
    expect(mergedBytes[0]).toBe(0x89)
    const batch = await runAssetBatch({
      document: before, pageId: page, revision: editor.state.version, tasks: selected, encoding: '',
      signal: new AbortController().signal,
    })
    expect(editor.state.doc).toBe(before)
    expect(JSON.stringify(editor.state.doc)).toBe(json)
    expect(editor.canUndo).toBe(false)
    expect(editor.state.version).toBe(listed[0].revision)
    expect(batch.manifest.complete).toBe(true)
    expect(batch.manifest.fileCount).toBe(4)
    expect(batch.files.map(file => file.path)).toEqual(['Rect@one.png', 'Rect@vector.svg', 'Ellipse@one.png', 'Ellipse@vector.svg'])
    expect(assetBatchSummary(batch.manifest)).toBe('已完成 4 个文件。')
    const pngs = batch.files.filter(file => file.path.endsWith('.png'))
    const svgs = batch.files.filter(file => file.path.endsWith('.svg'))
    expect(pngs).toHaveLength(2)
    expect(svgs).toHaveLength(2)
    for (const file of pngs) {
      expect([...file.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const view = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength)
      expect(view.getUint32(16)).toBeGreaterThan(0)
      expect(view.getUint32(20)).toBeGreaterThan(0)
    }
    const texts = svgs.map(file => new TextDecoder().decode(file.bytes))
    expect(texts[0]).not.toBe(texts[1])
    expect(texts.every(text => text.includes('<svg'))).toBe(true)
    expect(texts.some(text => text.includes('A'))).toBe(true)
    const zip = assetBatchZip(batch.files, batch.manifest)
    const packed = unzipSync(zip)
    expect(Object.keys(packed).sort()).toEqual([...batch.files.map(file => file.path), 'asset-manifest.json'].sort())
    for (const file of batch.files) expect([...packed[file.path]]).toEqual([...file.bytes])
    const manifest = JSON.parse(new TextDecoder().decode(packed['asset-manifest.json']))
    expect(manifest).toMatchObject({ format: 'futureox.asset-batch.v1', complete: true, fileCount: 4, revision: editor.state.version })
    expect(manifest.tasks).toHaveLength(4)
    expect(manifest.tasks.every((task: { nodeId: string; format: string; scale: number; suffix: string; path: string; status: string }) =>
      task.status === 'succeeded' && task.scale === 1 && (task.suffix === '@one' || task.suffix === '@vector') && task.path.startsWith(task.nodeId === rect.id ? 'Rect' : 'Ellipse'))).toBe(true)
  } finally { editor.dispose(); vi.unstubAllGlobals() }
})

test('a hidden preset fails on its own and does not cancel a visible sibling', async () => {
  const { doc, rect, hidden } = twoLayers()
  const tasks = tasksOf(doc).filter(task => task.format === 'png' && (task.nodeId === rect.id || task.nodeId === hidden.id))
  const seen: string[] = []
  const result = await runAssetBatch({
    document: doc, pageId: doc.pages[0].id, revision: 3, tasks, encoding: '',
    signal: new AbortController().signal,
    exportImage: async (_doc, _page, format, _scale, _color, _signal, target) => {
      seen.push(format)
      expect(target).toMatchObject({ kind: 'selection', nodeIds: [rect.id] })
      return { blob: new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)]), width: 40, height: 24 }
    },
  })
  expect(seen).toEqual(['png'])
  expect(result.manifest.complete).toBe(false)
  expect(result.manifest.fileCount).toBe(1)
  expect(result.manifest.tasks.find(task => task.nodeId === hidden.id)?.error).toContain('可见')
  expect(result.files.map(file => file.path)).toEqual(['Rect@one.png'])
})
