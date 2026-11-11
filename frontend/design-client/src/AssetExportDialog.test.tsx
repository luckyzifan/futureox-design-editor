// @ts-expect-error jsdom is a test-only dependency.
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { AssetExportDialog } from './AssetExportDialog'
import { assetManifest, type AssetTaskState } from './asset-batch'
import { ExportPanel } from './ExportPanel'
import { Editor } from './engine'
import { fileMenuText } from './file-menu-messages'
import { interfacePreference } from './interface-preference'
import { blank, node, uid, type ExportSetting } from './model'

const exporter = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./export', () => ({ exportRasterBatch: (...args: unknown[]) => exporter.run(...args), filename: (name: string) => name }))

function preset(format: ExportSetting['format'], suffix: string): ExportSetting {
  return { id: uid(), format, scale: 1, suffix }
}
function sampleDocument() {
  const doc = blank('Assets')
  doc.schemaVersion = 8
  const rect = node('rectangle', 0, 0, 20, 12)
  const ellipse = node('ellipse', 40, 0, 16, 16)
  rect.name = 'Rect'
  ellipse.name = 'Ellipse'
  rect.exportSettings = [preset('png', '@one'), preset('svg', '@vector')]
  ellipse.exportSettings = [preset('png', '@one'), preset('svg', '@vector')]
  doc.nodes = { [rect.id]: rect, [ellipse.id]: ellipse }
  doc.pages[0].children = [rect.id, ellipse.id]
  return doc
}

let dom: JSDOM, root: Root, editor: Editor
afterEach(async () => {
  await act(async () => root?.unmount())
  editor?.dispose()
  interfacePreference.reset()
  dom?.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(mode: 'figma' | 'sketch' = 'figma', locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (root) await act(async () => root.unmount())
  editor?.dispose()
  dom?.window.close()
  dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage']) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let urls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:asset-${urls++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  interfacePreference.set({ uiMode: mode, locale })
  editor = new Editor(sampleDocument())
  root = (await import('react-dom/client')).createRoot(document.getElementById('mount')!)
  return editor
}

function rows() {
  return [...document.querySelectorAll<HTMLLIElement>('.asset-export-list li')]
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))
}
function status(kind: 'batch' | 'delivery') {
  return document.querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.textContent ?? ''
}

test('opening the list is read-only in both layouts and fits a small window from the keyboard', async () => {
  const css = readFileSync(new URL('./asset-export.css', import.meta.url), 'utf8')
  expect(css).toContain('width: min(640px, calc(100vw - 16px))')
  expect(css).toContain('max-height: calc(100vh - 16px)')
  expect(css).toContain('overflow: auto')
  expect(readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')).toContain('menuText.exportAllAssets')
  expect(fileMenuText['zh-CN'].exportAllAssets).toBe('导出全部资源…')
  expect(fileMenuText.en.exportAllAssets).toBe('Export all assets…')
  expect(fileMenuText['zh-CN'].exportImages).toContain('导出图像')

  for (const mode of ['figma', 'sketch'] as const) {
    const locale = mode === 'sketch' ? 'en' : 'zh-CN'
    const current = await mount(mode, locale)
    const change = vi.spyOn(current, 'change')
    const update = vi.spyOn(current, 'updateProperties')
    const before = current.state.doc
    const json = JSON.stringify(before)
    const closed = vi.fn()
    await act(async () => root.render(<AssetExportDialog editor={current} onClose={closed} />))
    const backdrop = document.querySelector<HTMLElement>('.asset-export-backdrop')
    expect(backdrop?.getAttribute('data-ui-mode')).toBe(mode)
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(locale === 'en' ? 'All assets' : '全部资源')
    expect(rows().map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Rect'), expect.stringContaining('Ellipse'), expect.stringContaining('@one'), expect.stringContaining('@vector'),
    ]))
    expect(rows()).toHaveLength(4)
    expect(document.querySelector('[aria-label="Filter by layer"], [aria-label="按图层筛选"]')).toBe(document.activeElement)
    const filter = document.querySelector<HTMLInputElement>(locale === 'en' ? '[aria-label="Filter by layer"]' : '[aria-label="按图层筛选"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, 'Ell')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rows()).toHaveLength(2)
    const format = document.querySelector<HTMLSelectElement>(locale === 'en' ? '[aria-label="Filter by format"]' : '[aria-label="按格式筛选"]')!
    await act(async () => { format.value = 'svg'; format.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('svg')
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
    controls.at(-1)!.focus()
    await act(async () => controls.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(controls[0])
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(closed).toHaveBeenCalledOnce()
    expect(change).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(current.state.doc).toBe(before)
    expect(JSON.stringify(current.state.doc)).toBe(json)
    expect(current.canUndo).toBe(false)
    expect(current.state.doc.nodes[Object.keys(before.nodes)[0]].exportSettings).toEqual(before.nodes[Object.keys(before.nodes)[0]].exportSettings)
    await act(async () => root.unmount())
  }
})

test('partial failure stays incomplete until every selected preset succeeds, including retry', async () => {
  const current = await mount()
  let attempt = 0
  const run = vi.fn(async (options: { document: { id: string }; pageId: string; revision: number; tasks: { id: string; nodeId: string; settingId: string; revision: number; format: ExportSetting['format']; scale: number; suffix: string; path: string }[] }) => {
    attempt += 1
    const states: AssetTaskState[] = options.tasks.map((task, index) => ({
      taskId: task.id, nodeId: task.nodeId, settingId: task.settingId, revision: task.revision,
      format: task.format, scale: task.scale, suffix: task.suffix, path: task.path,
      status: attempt === 1 && index === 0 ? 'failed' : 'succeeded',
      ...(attempt === 1 && index === 0 ? { error: '模拟失败' } : { byteLength: 4 }),
    }))
    const files = states.filter(state => state.status === 'succeeded').map(state => ({ path: state.path, bytes: Uint8Array.of(9, 8, 7, 6), mime: 'image/png', taskId: state.taskId }))
    return { manifest: assetManifest({ documentId: options.document.id, pageId: options.pageId, revision: options.revision, tasks: states }), files }
  })
  const downloads: { name: string; blob: Blob }[] = []
  await act(async () => root.render(<AssetExportDialog editor={current} onClose={() => {}} run={run as never} deliverFiles={(name, blob) => { downloads.push({ name, blob }) }} />))
  const before = current.state.doc
  await act(async () => button('导出所选')!.click())
  expect(run).toHaveBeenCalledOnce()
  const first = run.mock.calls[0][0]
  expect(first.tasks).toHaveLength(4)
  expect(first.tasks.map((task: { path: string; revision: number; suffix: string }) => [task.path, task.suffix, task.revision])).toEqual([
    ['Rect@one.png', '@one', current.state.version],
    ['Rect@vector.svg', '@vector', current.state.version],
    ['Ellipse@one.png', '@one', current.state.version],
    ['Ellipse@vector.svg', '@vector', current.state.version],
  ])
  expect(status('batch')).toBe('未完成：3 个成功，1 个失败，0 个已取消。')
  expect(status('batch')).not.toContain('已完成')
  expect(document.body.textContent).toContain('失败：模拟失败')
  expect(current.state.doc).toBe(before)
  expect(current.canUndo).toBe(false)
  await act(async () => button('重试失败项')!.click())
  expect(attempt).toBe(2)
  expect(status('batch')).toBe('已完成 4 个文件。')
  await act(async () => button('下载 ZIP')!.click())
  const zip = downloads.find(item => item.name.endsWith('.zip'))
  expect(zip).toBeTruthy()
  expect((await zip!.blob.arrayBuffer()).byteLength).toBeGreaterThan(0)
  expect(current.canUndo).toBe(false)
})

test('cancelling a batch lists each unfinished preset as cancelled', async () => {
  const current = await mount()
  const before = current.state.doc
  const run = (options: { document: { id: string }; pageId: string; revision: number; tasks: { id: string; nodeId: string; settingId: string; revision: number; format: ExportSetting['format']; scale: number; suffix: string; path: string }[]; signal: AbortSignal }) => new Promise<{ manifest: ReturnType<typeof assetManifest>; files: [] }>(resolve => {
    options.signal.addEventListener('abort', () => {
      const tasks: AssetTaskState[] = options.tasks.map(task => ({
        taskId: task.id, nodeId: task.nodeId, settingId: task.settingId, revision: task.revision,
        format: task.format, scale: task.scale, suffix: task.suffix, path: task.path, status: 'cancelled',
      }))
      resolve({ manifest: assetManifest({ documentId: options.document.id, pageId: options.pageId, revision: options.revision, tasks }), files: [] })
    })
  })
  await act(async () => root.render(<AssetExportDialog editor={current} onClose={() => {}} run={run as never} />))
  await act(async () => {
    button('导出所选')!.click()
    await Promise.resolve()
    button('取消')!.click()
  })
  expect(status('batch')).toBe('未完成：0 个成功，0 个失败，4 个已取消。')
  expect(document.body.textContent).toContain('已取消')
  expect(status('batch')).not.toContain('已完成')
  expect(current.state.doc).toBe(before)
  expect(current.canUndo).toBe(false)
})

test('the export panel keeps merged selection and can open the asset list without rendering', async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  editor = new Editor(sampleDocument())
  editor.select(editor.state.doc.pages[0].children)
  root = (await import('react-dom/client')).createRoot(document.getElementById('mount')!)
  const opened = vi.fn()
  await act(async () => root.render(<ExportPanel editor={editor} onClose={() => {}} onOpenAssets={opened} />))
  expect(document.body.textContent).toContain('选中图层')
  expect(button('生成 PNG')).toBeTruthy()
  exporter.run.mockClear()
  await act(async () => button('全部资源')!.click())
  expect(opened).toHaveBeenCalledOnce()
  expect(exporter.run).not.toHaveBeenCalled()
})
