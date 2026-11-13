// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { afterEach, expect, test, vi } from 'vitest'
import * as exportApi from './export'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, node, paint } from './model'
import { ExportPanel } from './ExportPanel'
import type { KernelOptions } from './kernel/client'
import { VectorEngine, transcode_export_png } from './generated/design-kernel/design_kernel'

class ExportCpuWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: (event: { message: string }) => void
  private engine = new VectorEngine()
  terminated = false
  constructor() {
    this.engine.load_font(new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))))
  }
  postMessage(request: { id: number; document?: string; options?: KernelOptions; command?: string }) {
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

const blobs: Blob[] = []
function mountDom() {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://design.invalid' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'Document']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', ExportCpuWorker)
  blobs.length = 0
  let sequence = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return `blob:asset-${sequence++}` })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return dom
}

function issueEditor() {
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
  const editor = new Editor(doc)
  editor.select([rect.id, ellipse.id])
  return { editor, rect, ellipse }
}

afterEach(() => {
  interfacePreference.set({ locale: 'zh-CN', uiMode: 'figma' })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('merged selection stays one file while All Assets is a separate preset list', async () => {
  const dom = mountDom()
  const { editor, rect, ellipse } = issueEditor()
  const raster = vi.spyOn(exportApi, 'exportRasterBatch').mockResolvedValue([{ name: 'merged.png', blob: new Blob(['png']), backend: 'cpu', width: 100, height: 30, scale: 1 }])
  const root = createRoot(document.getElementById('root')!)
  const closed = vi.fn()
  try {
    await act(async () => { root.render(<ExportPanel editor={editor} onClose={closed} />) })
    expect(document.body.textContent).toContain('合并为一个文件')
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '生成 PNG')!.click() })
    await vi.waitFor(() => expect(raster).toHaveBeenCalledTimes(1))
    const target = raster.mock.calls[0][3]
    expect(target).toMatchObject({ kind: 'selection', nodeIds: [rect.id, ellipse.id] })
    const assets = [...document.querySelectorAll('input[name="export-target"]')].find(input => input.parentElement?.textContent?.includes('全部图层预设')) as HTMLInputElement
    expect(assets).toBeTruthy()
    await act(async () => { assets.click() })
    await vi.waitFor(() => expect(document.querySelector('[aria-label="全部资产"]')).toBeTruthy())
    expect(raster).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('button')].some(button => button.textContent === '生成 PNG')).toBe(false)
    expect(document.querySelectorAll('[aria-label$="@one"], [aria-label*="@one"]')).toHaveLength(2)
    expect(editor.state.version).toBe(0)
    expect(editor.canUndo).toBe(false)
    expect(editor.state.doc.nodes[rect.id].exportSettings).toEqual(rect.exportSettings)
  } finally {
    await act(async () => root.unmount())
    editor.dispose()
    dom.window.close()
  }
})

test('both layouts can filter, uncheck and export the issue presets without touching history', async () => {
  const dom = mountDom()
  const { editor, rect } = issueEditor()
  const root = createRoot(document.getElementById('root')!)
  const closed = vi.fn()
  const before = editor.state.doc
  try {
    for (const mode of ['figma', 'sketch'] as const) {
      interfacePreference.set({ locale: 'zh-CN', uiMode: mode })
      await act(async () => { root.render(<ExportPanel editor={editor} onClose={closed} initialTarget="assets" />) })
      await vi.waitFor(() => expect(document.querySelector('[aria-label="全部资产"]')).toBeTruthy())
      expect(document.body.textContent).toContain('已选 4 / 4 项预设')
    }
    interfacePreference.set({ locale: 'en', uiMode: 'sketch' })
    await act(async () => {})
    expect(document.body.textContent).toContain('Export selected presets')
    expect(document.body.textContent).toContain('4 of 4 presets selected')
    interfacePreference.set({ locale: 'zh-CN', uiMode: 'figma' })
    await act(async () => {})
    const format = document.querySelector<HTMLSelectElement>('[aria-label="按格式筛选资产"]')!
    await act(async () => { format.value = 'svg'; format.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(document.querySelector('[aria-label="矩形 PNG 1x @one"]')).toBeNull()
    expect(document.querySelector('[aria-label="矩形 SVG 1x @vector"]')).toBeTruthy()
    expect(document.body.textContent).toContain('已选 4 / 4 项预设')
    await act(async () => { format.value = 'all'; format.dispatchEvent(new Event('change', { bubbles: true })) })
    const box = document.querySelector<HTMLInputElement>('[aria-label="椭圆 PNG 1x @one"]')!
    await act(async () => { box.click() })
    expect(document.body.textContent).toContain('已选 3 / 4 项预设')
    expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(0)
    expect(editor.canUndo).toBe(false)
    expect(JSON.stringify(editor.state.doc.nodes[rect.id].exportSettings)).toBe(JSON.stringify(rect.exportSettings))
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '导出所选预设')!.click() })
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain('已导出 3 个文件'), { timeout: 20000 })
    expect(document.body.textContent).not.toContain('已导出 4 个文件')
    expect(editor.state.version).toBe(0)
    expect(editor.canUndo).toBe(false)
    const zip = [...document.querySelectorAll('a')].find(anchor => anchor.textContent?.includes('下载 ZIP'))!
    await act(async () => { zip.click() })
    const packed = blobs.at(-1)!
    const files = unzipSync(new Uint8Array(await packed.arrayBuffer()))
    expect(Object.keys(files).filter(name => name !== 'manifest.json').sort()).toEqual(['椭圆@vector.svg', '矩形@one.png', '矩形@vector.svg'])
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']))
    expect(manifest.complete).toBe(true)
    expect(manifest.counts).toMatchObject({ selected: 3, delivered: 3, failed: 0 })
    expect(manifest.items.map((item: { path: string; nodeId: string }) => item.nodeId).sort()).toEqual([rect.id, rect.id, editor.state.doc.pages[0].children[1]].sort())
    const dialog = document.querySelector<HTMLElement>('[aria-label="导出图像"]')!
    const stops = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
    expect(stops.length).toBeGreaterThan(4)
    stops.at(-1)!.focus()
    await act(async () => { stops.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(stops[0])
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(closed).toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    editor.dispose()
    dom.window.close()
  }
})
