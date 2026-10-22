import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { operationStatusText, type OperationStatus } from './operation-status-messages'
import { dispatchEditorCommand } from './editor-commands'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture() { const d = blank(), n = node('rectangle', 0, 0, 20, 20); d.nodes[n.id] = n; d.pages[0].children = [n.id]; return { e: new Editor(d), n } }
const tag = (e: Editor) => e.notify('已复制属性', { key: 'propertiesCopied' })
const display = (e: Editor) => operationStatusText(e.state.message, e.state.messagePresentation, 'en')
test('same-value notify/set messages clear metadata; selection/view preserve it', () => {
  const { e, n } = fixture()
  try {
    tag(e); const meta = e.state.messagePresentation
    e.select([n.id]); e.set({ view: { x: 1, y: 2, zoom: 1 } })
    expect(e.state.messagePresentation).toBe(meta); expect(display(e)).toBe('Properties copied')
    e.notify('已复制属性'); expect(e.state.messagePresentation).toBeUndefined(); expect(display(e)).toBe('已复制属性')
    tag(e); e.set({ message: '已复制属性' }); expect(e.state.messagePresentation).toBeUndefined()
    tag(e); e.set({ message: 'Untyped author text 已复制属性' }); expect(display(e)).toBe('Untyped author text 已复制属性')
  } finally { e.dispose() }
})
test('authored/history labels and load cannot retain a previous localized tag; serialized document stays unchanged', () => {
  const { e, n } = fixture(), before = JSON.stringify(e.state.doc)
  try {
    tag(e); expect(JSON.stringify(e.state.doc)).toBe(before)
    e.change('已复制属性', d => { d.nodes[n.id].name = '已复制属性 author name' })
    expect(e.state.messagePresentation).toBeUndefined(); expect(display(e)).toBe('已复制属性')
    const after = e.state.doc; tag(e); e.undo(); expect(e.state.messagePresentation).toBeUndefined(); expect(display(e)).toBe('撤销：已复制属性')
    tag(e); e.redo(); expect(e.state.messagePresentation).toBeUndefined(); expect(display(e)).toBe('重做：已复制属性'); expect(e.state.doc).toEqual(after)
    tag(e); e.load(blank()); expect(e.state.messagePresentation).toBeUndefined(); expect(display(e)).toBe(e.state.message)
    expect(JSON.stringify(e.state.doc)).not.toContain('messagePresentation')
  } finally { e.dispose() }
})
test('unknown tag and raw mismatch fall back verbatim; caller cannot mutate copied status params', () => {
  const { e } = fixture()
  try {
    expect(operationStatusText('Raw <>&', { raw: 'Raw <>&', status: { key: 'future' } as any }, 'en')).toBe('Raw <>&')
    expect(operationStatusText('new', { raw: 'old', status: { key: 'propertiesCopied' } }, 'en')).toBe('new')
    const status: OperationStatus = { key: 'saveFailedCanvasRetained', error: '原始 <>&' }
    e.notify('raw failure', status); status.error = 'changed'; expect(display(e)).toContain('原始 <>&')
  } finally { e.dispose() }
})
test('locale-only resolution has no Editor notifications, timers, history or lifetime changes', () => {
  vi.useFakeTimers(); const { e } = fixture()
  try {
    tag(e); const state = e.state, listener = vi.fn(), stop = e.subscribe(listener), sentinel = vi.fn()
    setTimeout(sentinel, 350); vi.advanceTimersByTime(100)
    const timers = vi.getTimerCount()
    for (const locale of ['en', 'zh-CN', 'en'] as const) operationStatusText(e.state.message, e.state.messagePresentation, locale)
    expect(e.state).toBe(state); expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(timers)
    vi.advanceTimersByTime(249); expect(sentinel).not.toHaveBeenCalled(); vi.advanceTimersByTime(1); expect(sentinel).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15000); expect(e.state).toBe(state); expect(e.canUndo).toBe(false); stop()
  } finally { e.dispose() }
})
test('real property-copy producer retains exact raw message, command result and clipboard payload', async () => {
  const { e, n } = fixture(); e.select([n.id]); const before = e.state.doc, write = vi.fn(async (_value: unknown) => ({ status: 'ok' }))
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write } } })
  try { await dispatchEditorCommand(e, 'copy-properties'); expect(write).toHaveBeenCalledTimes(1)
    expect(e.state.message).toBe('已复制属性'); expect(display(e)).toBe('Properties copied'); expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
    await dispatchEditorCommand(e, 'set-tool-unknown-author-ID'); expect(e.state.message).toBe('未知工具命令 set-tool-unknown-author-ID')
    expect(display(e)).toBe('Unknown tool command set-tool-unknown-author-ID'); expect(e.state.tool).toBe('select'); expect(e.state.doc).toBe(before)
  } finally { e.dispose() }
})
test.each(['success', 'cancelled', 'stale-session'] as const)('pending export %s keeps existing owner fences and resolves completion in current locale', async outcome => {
  const { ExportOwner } = await import('./export-ownership')
  const { e } = fixture(), owner = new ExportOwner({ createObjectURL: () => 'blob:test-status', revokeObjectURL: () => {} })
  owner.activate(e)
  try {
    const request = owner.begin(e, 'status-test')!
    e.notify('正在生成导出预览…', { key: 'exportPreviewGenerating' })
    let locale: 'en' | 'zh-CN' = 'zh-CN', finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve }).then(() => {
      if (owner.publish(request, { blob: new Blob(['asset']), name: '作者.svg' })) e.notify('导出文件已生成', { key: 'exportFileReady' })
    })
    locale = 'en'
    if (outcome === 'cancelled') owner.cancel(request)
    if (outcome === 'stale-session') e.load(blank('new authored document'))
    const beforeCompletion = e.state.message
    finish(); await pending
    if (outcome === 'success') expect(operationStatusText(e.state.message, e.state.messagePresentation, locale)).toBe('Export file ready')
    else { expect(e.state.message).toBe(beforeCompletion); expect(e.state.messagePresentation?.status.key).not.toBe('exportFileReady') }
    expect(e.canUndo).toBe(false)
  } finally { owner.dispose(); e.dispose() }
})
