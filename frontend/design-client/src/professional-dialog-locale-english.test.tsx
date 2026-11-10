// Mounted dialogs and Editor. jsdom does not certify Electron or native GPU layout.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { interfacePreference } from './interface-preference'
import { BatchRenameDialog } from './BatchRenameDialog'
import { ColorPanel } from './ColorPanel'
import { DesignTools } from './DesignTools'
import { DocumentHistoryDialog } from './DocumentHistoryDialog'
import { ExportOwner } from './export-ownership'
import { PrototypeLogicBuilder } from './PrototypeLogicBuilder'
import { SketchEditDialog } from './SketchEditDialog'
import { SketchInspectionDialog } from './SketchInspectionDialog'
import { WorkspaceLibrary } from './WorkspaceLibrary'
import { dispatchEditorCommand } from './editor-commands'
import { translateProfessional } from './professional-dialog-messages'
import type { DesktopSession } from './desktop-session'
import type { SketchSessionBridge } from './desktop'
import type { SketchInspection } from './sketch-inspection'

const historyApi = vi.hoisted(() => ({
  route: 'local' as const,
  list: vi.fn(async () => ({ entries: [
    { revision: 2, createdAt: Date.parse('2026-01-02T00:00:00Z'), summary: '作者保存' },
    { revision: 1, createdAt: Date.parse('2026-01-01T00:00:00Z') },
  ], hasMore: false })),
  load: vi.fn(async () => null),
  restore: vi.fn(async () => false),
}))
vi.mock('./document-history', () => ({ createDocumentHistory: () => historyApi }))

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  return dom
})
bootstrap.window.close()

let dom: JSDOM, root: Root, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><button id="trigger">Open</button><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  historyApi.list.mockClear(); historyApi.load.mockClear(); historyApi.restore.mockClear()
  editor = new Editor(blank('作者文档'))
  root = createRoot(document.getElementById('mount')!)
  document.getElementById('trigger')!.focus()
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
})

const locale = (value: 'en' | 'zh-CN') => act(async () => { interfacePreference.set({ locale: value }) })
const text = () => document.body.textContent || ''
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent === name)

test('english catalog keeps unknown diagnostics and translates only known dialog copy', () => {
  expect(translateProfessional('constructor', 'en')).toBe('constructor')
  expect(translateProfessional('__proto__', 'en')).toBe('__proto__')
  expect(translateProfessional('历史版本 r3 已不存在，请刷新列表', 'en')).toBe('Version r3 no longer exists. Refresh the list.')
  expect(translateProfessional('前缀无效，最多 200 个字符且不能含控制字符', 'en')).toContain('Prefix')
  expect(translateProfessional('历史版本 r3 已不存在，请刷新列表', 'zh-CN')).toBe('历史版本 r3 已不存在，请刷新列表')
  expect(translateProfessional('作者保存', 'en')).toBe('作者保存')
})

test('version history, color, library and batch rename follow the selected language without rewriting authored names', async () => {
  const layer = node('rectangle', 0, 0, 20, 20)
  layer.name = '作者红'
  const doc = editor.state.doc
  doc.nodes[layer.id] = layer
  doc.pages[0].children = [layer.id]
  editor.dispose()
  editor = new Editor(doc)
  editor.select([layer.id])
  const before = editor.state.doc
  await act(async () => root.render(<ColorPanel editor={editor} onClose={() => {}} exports={new ExportOwner()} />))
  expect(text()).toContain('色彩与 HDR')
  expect(text()).toContain('启用广色域 / HDR')
  await locale('en')
  expect(text()).toContain('Color and HDR')
  expect(text()).toContain('Enable wide gamut / HDR')
  expect(text()).not.toContain('色彩与 HDR')
  expect(text()).not.toContain('启用广色域 / HDR')
  await act(async () => button('Enable wide gamut / HDR')!.click())
  expect(editor.state.message).toBe('启用色彩管理')
  expect(text()).toContain('作者红 · Fill 1')
  expect(text()).not.toContain('填充 1')
  await locale('zh-CN')
  expect(text()).toContain('色彩与 HDR')
  expect(text()).toContain('作者红 · 填充 1')
  expect(editor.state.doc.nodes[layer.id].name).toBe('作者红')

  await act(async () => root.render(<DocumentHistoryDialog documentId={before.id} documentName="作者文档" unsaved={false} onLocalAdopt={() => true} onClose={() => {}} />))
  await vi.waitFor(() => expect(text()).toContain('作者保存'))
  expect(text()).toContain('历史版本')
  await locale('en')
  expect(text()).toContain('Version history')
  expect(text()).toContain('Refresh')
  expect(text()).toContain('Preview')
  expect(text()).toContain('Restore this version')
  expect(text()).toContain('作者保存')
  expect(text()).toContain('作者文档')
  expect(text()).not.toContain('历史版本')
  expect(text()).not.toContain('恢复此版本')
  await locale('zh-CN')
  expect(button('刷新')).toBeTruthy()
  expect(button('恢复此版本')).toBeTruthy()

  const session = {
    activeDocumentId: 'other',
    status: { error: '' },
    listWorkspace: vi.fn(async () => ({ status: 'ok' as const, documents: [{ id: 'doc-1', name: '作者设计', revision: 4, updatedAt: Date.parse('2026-03-01T00:00:00Z'), deleted: false, hash: 'h' }] })),
    listRevisions: vi.fn(async () => ({ status: 'ok' as const, revisions: [{ id: 'doc-1', name: '作者设计', revision: 4, updatedAt: Date.parse('2026-03-01T00:00:00Z'), deleted: false, hash: 'h' }], hasMore: false })),
    openWorkspace: vi.fn(async () => false),
    trashWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
  } as unknown as DesktopSession
  await act(async () => root.render(<WorkspaceLibrary session={session} onClose={() => {}} />))
  await vi.waitFor(() => expect(text()).toContain('作者设计'))
  expect(text()).toContain('本机文档库')
  expect(text()).toContain('回收站')
  await locale('en')
  expect(text()).toContain('Local design library')
  expect(text()).toContain('Trash')
  expect(text()).toContain('Refresh')
  expect(text()).toContain('Version history')
  expect(text()).toContain('作者设计')
  expect(text()).not.toContain('本机文档库')
  expect(text()).not.toContain('回收站')
  await locale('zh-CN')
  expect(text()).toContain('本机文档库')
  expect(text()).toContain('回收站')

  const first = node('rectangle'), second = node('rectangle')
  first.name = 'Item A'; second.name = '作者图层'
  const renameDoc = blank('Rename')
  renameDoc.nodes = { [first.id]: first, [second.id]: second }
  renameDoc.pages[0].children = [first.id, second.id]
  editor.dispose()
  editor = new Editor(renameDoc)
  editor.select([first.id, second.id])
  const canvas = document.createElement('div')
  canvas.tabIndex = 0
  canvas.dataset.testid = 'canvas'
  document.body.append(canvas)
  await act(async () => root.render(<BatchRenameDialog editor={editor} />))
  await act(async () => dispatchEditorCommand(editor, 'rename'))
  const prefix = [...document.querySelectorAll('label')].find(item => item.firstChild?.textContent === '前缀')!.querySelector('input')!
  await act(async () => {
    prefix.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(prefix, 'UI/')
    prefix.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(prefix.value).toBe('UI/')
  await locale('en')
  expect(document.querySelector('h2')!.textContent).toBe('Batch rename')
  expect(text()).toContain('Name rules')
  expect(text()).toContain('Apply rename')
  expect(text()).not.toContain('批量重命名')
  expect(text()).toContain('作者图层')
  expect(prefix.value).toBe('UI/')
  expect(document.activeElement).toBe(prefix)
  await act(async () => button('Apply rename')!.click())
  expect(editor.state.doc.nodes[second.id].name).toBe('UI/作者图层')
  expect(editor.state.message).toBe('批量重命名')
  expect(editor.canUndo).toBe(true)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[second.id].name).toBe('作者图层')
  expect(editor.state.doc).not.toBe(before)
})

test('design system and native sketch dialogs switch with the interface language', async () => {
  const frame = node('frame', 0, 0, 100, 80)
  frame.name = '作者画板'
  const doc = editor.state.doc
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  editor.dispose()
  editor = new Editor(doc)
  editor.select([frame.id])
  const unchanged = editor.state.doc
  await act(async () => root.render(<DesignTools editor={editor} onClose={() => {}} />))
  expect(text()).toContain('设计系统与交互')
  expect(text()).toContain('变量与主题')
  await locale('en')
  expect(text()).toContain('Design system and interactions')
  expect(text()).toContain('Variables and themes')
  expect(text()).toContain('Local variables')
  expect(text()).not.toContain('设计系统与交互')
  expect(text()).not.toContain('本地变量')
  await act(async () => button('Shared styles')!.click())
  expect(document.querySelector('[aria-label="Style name"]')).toBeTruthy()
  expect(document.querySelector('input')!.getAttribute('placeholder')).toBe('Style name')
  await act(async () => button('Libraries')!.click())
  expect(text()).toContain('Publish library file')
  await act(async () => button('Prototype')!.click())
  expect(text()).toContain('Interactions for 作者画板')
  expect(text()).toContain('Add interaction')
  expect(text()).not.toContain('交互原型')
  await act(async () => root.render(<PrototypeLogicBuilder doc={editor.state.doc} event={{ trigger: 'click', actions: [] }} onChange={() => {}} />))
  expect(text()).toContain('Advanced logic builder')
  expect(text()).toContain('Add conditional branch')
  expect(text()).not.toContain('高级逻辑构建器')
  await locale('zh-CN')
  expect(text()).toContain('高级逻辑构建器')
  expect(button('添加条件分支')).toBeTruthy()
  await act(async () => root.render(<DesignTools editor={editor} onClose={() => {}} initialTab="prototype" />))
  expect(text()).toContain('共享样式')
  expect(button('交互原型')).toBeTruthy()
  expect(editor.state.doc).toBe(unchanged)

  const inspection: SketchInspection = {
    displayName: '作者.sketch', pageCount: 2, layerCount: 9, editable: false, renderable: false,
    owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: '8eafc349-45d2-405c-9405-cb07ef12c9a8', session_epoch: 1 },
    preview: { status: 'unavailable', reason: 'Unsupported native feature' },
  }
  await act(async () => root.render(<SketchInspectionDialog result={null} onClose={() => {}} onChoose={() => {}} />))
  await locale('en')
  expect(text()).toContain('Open Sketch file')
  expect(text()).toContain('Choose Sketch file…')
  expect(text()).not.toContain('打开 Sketch 文件')
  await act(async () => root.render(<SketchInspectionDialog result={inspection} onClose={() => {}} />))
  expect(text()).toContain('作者.sketch')
  expect(text()).toContain('2 pages · 9 layers (including pages)')
  expect(text()).toContain('This file contains content that native read-only preview cannot draw yet.')
  expect(text()).toContain('Unsupported native feature')
  expect(text()).toContain('Import a compatibility format')
  expect(text()).not.toContain('确认打开保持禁用')
  expect(text()).not.toContain('个图层')
  await locale('zh-CN')
  expect(button('确认打开')).toBeTruthy()
  expect(text()).toContain('2 页 · 9 个图层（含页面）')

  const bridge = { open: vi.fn(async () => ({ status: 'cancelled' as const })), status: vi.fn(), close: vi.fn(), rename: vi.fn(), undo: vi.fn(), redo: vi.fn(), saveAs: vi.fn(), leafFrame: vi.fn(), setLeafFrame: vi.fn(), resizeLegacy: vi.fn(), textTargets: vi.fn(), setTextOverride: vi.fn() } as unknown as SketchSessionBridge
  await act(async () => root.render(<SketchEditDialog bridge={bridge} onClose={() => {}} />))
  await locale('en')
  expect(text()).toContain('Separate Sketch editing session (limited)')
  expect(text()).toContain('Choose or resume a native Sketch session…')
  expect(text()).not.toContain('独立 Sketch 编辑会话')
  expect(text()).not.toContain('选择或恢复 Sketch 原生会话')
  await locale('zh-CN')
  expect(text()).toContain('独立 Sketch 编辑会话（有限支持）')
  expect(editor.state.doc).toBe(unchanged)
})
