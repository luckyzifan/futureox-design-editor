// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { ExportPanel } from './ExportPanel'
import { canvasActions, CanvasAction, ActionOutcome } from './canvas-action-diagnostics'
const exporter = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./export', () => ({ exportRasterBatch: (...args: unknown[]) => exporter.run(...args) }))
test('the top export offers TIFF and explains bit depth and transparency', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://design.invalid' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const editor = new Editor(blank())
  const root = createRoot(document.getElementById('root')!)
  try {
    await act(async () => root.render(<ExportPanel editor={editor} onClose={() => {}} />))
    const select = document.querySelector<HTMLSelectElement>('[aria-label="导出图像格式"]')!
    expect([...select.options].map(option => option.value)).toEqual(['sketch', 'svg', 'png', 'jpeg', 'webp', 'tiff', 'pdf', 'pdf-vector'])
    expect(select.querySelector('option[value="tiff"]')?.textContent).toBe('TIFF')
    expect(document.body.textContent).not.toContain('HEIC')
    await act(async () => { select.value = 'tiff'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(document.body.textContent).toContain('8 位图像')
    expect(document.body.textContent).toContain('透明度')
    expect(document.body.textContent).not.toContain('HEIC')
  } finally { await act(async () => root.unmount()); editor.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close() }
})
test('an awaited export reports generation, not an unrelated concurrent document commit', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://design.invalid' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(window as any).coreDesktop = { renderDiagnostics: true, renderDiagnosticsDetail: true }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const editor = new Editor(blank('DO_NOT_LOG_EXPORT_DOCUMENT')); editor.add('rectangle', { x: 0, y: 0, width: 20, height: 20 })
  let complete!: (assets: unknown[]) => void
  exporter.run.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const root = createRoot(document.getElementById('root')!)
  try {
    await act(async () => root.render(<ExportPanel editor={editor} onClose={() => {}} />))
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '生成 PNG')!.click())
    await vi.waitFor(() => expect(exporter.run).toHaveBeenCalled())
    expect(canvasActions(editor).snapshot().rows.filter(r => r.actionCode === CanvasAction.export && r.actionPhase === 2)).toHaveLength(0)
    await act(async () => { editor.add('ellipse', { x: 30, y: 0, width: 20, height: 20 }) })
    await act(async () => { complete([{ name: 'DO_NOT_LOG_ASSET.png', blob: new Blob(['test']), width: 20, height: 20, scale: 1 }]) })
    const rows = canvasActions(editor).snapshot().rows.filter(r => r.actionCode === CanvasAction.export && r.actionPhase === 2)
    expect(rows.at(-1)).toMatchObject({ actionOutcome: ActionOutcome.observed, committedChanged: 0 })
    expect(JSON.stringify(rows)).not.toContain('DO_NOT_LOG')
  } finally { await act(async () => root.unmount()); editor.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close() }
})
