import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { applyBatchRename, planBatchRename } from './batch-rename'
import { batchRenameIsCurrent, batchRenameSnapshot, closeBatchRename, requestBatchRename } from './batch-rename-session'
import { dispatchEditorCommand } from './editor-commands'
import { canvasMenuItems } from './canvas-menu-model'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => { closeBatchRename(editor); editor.dispose() }) })
function fixture() {
  const doc = blank(), group = node('group'), a = node('rectangle'), b = node('rectangle'), other = node('rectangle')
  group.name = 'Group'; a.name = 'Item A'; b.name = 'Item B'; other.name = 'Unrelated'
  group.children = [a.id, b.id]; doc.pages[0].children = [group.id, other.id]
  for (const n of [group, a, b, other]) doc.nodes[n.id] = n
  const editor = new Editor(doc); editors.push(editor); editor.select([a.id, b.id])
  return { editor, group, a, b, other }
}
describe('batch rename pure plan and real Editor transaction', () => {
  it('combines literal replace, prefix/suffix and padded numbering in layer-panel order, not click order', () => {
    const { editor, a, b } = fixture(), doc = editor.state.doc
    const options = { prefix: 'UI/', suffix: '!', find: 'Item ', replace: 'Card ', numbering: { start: 3, step: 2, padding: 3, position: 'suffix' as const, separator: '-' } }
    const plan = planBatchRename(doc, editor.state.page, [a.id, b.id], options)
    expect(plan.entries).toEqual([{ id: b.id, from: 'Item B', to: 'UI/Card B!-003' }, { id: a.id, from: 'Item A', to: 'UI/Card A!-005' }])
    expect(planBatchRename(doc, editor.state.page, [b.id, a.id], options)).toEqual(plan)
    expect(doc.nodes[a.id].name).toBe('Item A')
  })
  it('literal replacement treats regex and replacement tokens as ordinary text', () => {
    const { editor, a } = fixture()
    editor.update([a.id], { name: 'a.$&a.$&' })
    expect(planBatchRename(editor.state.doc, editor.state.page, [a.id], { find: '.$&', replace: '$1' }).entries[0].to).toBe('a$1a$1')
  })
  it('renames only selected names with one history entry, preserves geometry/resources, and undo/redo/reopen roundtrips', () => {
    const { editor, a, b, group, other } = fixture()
    const before = editor.state.doc, version = editor.state.version, selection = editor.state.selection
    const plan = planBatchRename(before, editor.state.page, [a.id, b.id], { prefix: 'New ' })
    const result = editor.change('批量重命名', draft => applyBatchRename(draft, plan))
    expect(result.status).toBe('committed'); expect(editor.state.version).toBe(version + 1)
    const after = editor.state.doc
    expect(after.nodes[a.id]).toEqual({ ...before.nodes[a.id], name: 'New Item A' })
    expect(after.nodes[b.id]).toEqual({ ...before.nodes[b.id], name: 'New Item B' })
    expect(after.nodes[group.id]).toBe(before.nodes[group.id]); expect(after.nodes[other.id]).toBe(before.nodes[other.id]); expect(after.pages).toBe(before.pages)
    expect(editor.state.selection).toEqual(selection)
    editor.undo(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    editor.redo(); expect(editor.state.doc).toBe(after)
    const reopened = new Editor(JSON.parse(JSON.stringify(after))); editors.push(reopened)
    expect(reopened.state.doc.nodes[a.id].name).toBe('New Item A'); expect(reopened.state.doc.nodes[b.id].name).toBe('New Item B')
  })
  it('parent selection never expands to unselected descendants', () => {
    const { editor, group, other, a, b } = fixture(), before = editor.state.doc
    const plan = planBatchRename(before, editor.state.page, [group.id, other.id], { suffix: '!' })
    editor.change('Rename', draft => applyBatchRename(draft, plan))
    expect(editor.state.doc.nodes[a.id]).toBe(before.nodes[a.id]); expect(editor.state.doc.nodes[b.id]).toBe(before.nodes[b.id])
  })
  it.each(['selected-lock', 'ancestor-lock', 'inherited', 'instance-parent', 'wrong-page', 'missing', 'duplicate'])('atomically rejects %s before mutating any name', reason => {
    const { editor, a, b, group } = fixture()
    const doc = JSON.parse(JSON.stringify(editor.state.doc)), ids = [a.id, b.id]
    if (reason === 'selected-lock') doc.nodes[b.id].locked = true
    if (reason === 'ancestor-lock') doc.nodes[group.id].locked = true
    if (reason === 'inherited') doc.nodes[b.id].instanceOrigin = { owner: group.id, key: 'child' }
    if (reason === 'instance-parent') doc.nodes[group.id].instance = { componentId: 'master' }
    if (reason === 'wrong-page') doc.pages[0].children = []
    if (reason === 'missing') ids[1] = 'missing'
    if (reason === 'duplicate') ids[1] = a.id
    const before = JSON.stringify(doc)
    expect(() => planBatchRename(doc, editor.state.page, ids, { prefix: 'New ' })).toThrow()
    expect(JSON.stringify(doc)).toBe(before)
  })
  it('validates every final name and plan entry before editing a draft', () => {
    const { editor, a, b } = fixture(), before = editor.state.doc
    expect(() => planBatchRename(before, editor.state.page, [a.id, b.id], { prefix: 'x'.repeat(200) })).toThrow('200')
    expect(() => planBatchRename(before, editor.state.page, [a.id], { find: 'Item A', replace: '' })).toThrow('不能为空')
    expect(() => planBatchRename(before, editor.state.page, [a.id], { prefix: '\ud800' })).toThrow()
    const plan = planBatchRename(before, editor.state.page, [a.id, b.id], { prefix: 'New ' })
    const forged = { ...plan, entries: [plan.entries[0], { ...plan.entries[1], to: '' }] }
    expect(editor.change('Invalid batch', draft => applyBatchRename(draft, forged)).status).toBe('rejected')
    expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
  it.each([0, .5, NaN, Infinity])('rejects invalid numbering step %s', step => {
    const { editor, a } = fixture()
    expect(() => planBatchRename(editor.state.doc, editor.state.page, [a.id], { numbering: { start: 1, step, padding: 2, separator: ' ', position: 'prefix' } })).toThrow('编号')
  })
  it('supports descending numbers but rejects overflow/negative results', () => {
    const { editor, a, b } = fixture()
    const options = { numbering: { start: 2, step: -1, padding: 2, separator: ' ', position: 'prefix' as const } }
    expect(planBatchRename(editor.state.doc, editor.state.page, [a.id, b.id], options).entries.map(e => e.to)).toEqual(['02 Item B', '01 Item A'])
    expect(() => planBatchRename(editor.state.doc, editor.state.page, [a.id, b.id], { numbering: { ...options.numbering, start: 0 } })).toThrow()
    expect(() => planBatchRename(editor.state.doc, editor.state.page, [a.id, b.id], { numbering: { ...options.numbering, start: Number.MAX_SAFE_INTEGER, step: 1 } })).toThrow()
  })
  it('stale plan rejection preserves an unrelated intervening edit', () => {
    const { editor, a, b } = fixture()
    const plan = planBatchRename(editor.state.doc, editor.state.page, [a.id, b.id], { suffix: '!' })
    editor.update([a.id], { name: 'Intervening' }); const before = editor.state.doc, version = editor.state.version
    expect(editor.change('Stale batch', draft => applyBatchRename(draft, plan)).status).toBe('rejected')
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
    editor.undo(); expect(editor.state.doc.nodes[a.id].name).toBe('Item A'); expect(editor.canUndo).toBe(false)
  })
  it('multi-selection rename/menu opens a snapshot, single-selection retains inline rename', async () => {
    const { editor, a } = fixture()
    expect(canvasMenuItems(editor).find(item => item.command === 'rename')?.label).toBe('批量重命名…')
    await dispatchEditorCommand(editor, 'rename'); const session = batchRenameSnapshot(editor)!
    expect(session.selection).toEqual(editor.state.selection); expect(batchRenameIsCurrent(editor, session)).toBe(true); expect(editor.canUndo).toBe(false)
    closeBatchRename(editor); editor.select([a.id]); await dispatchEditorCommand(editor, 'rename')
    expect(batchRenameSnapshot(editor)).toBeNull(); expect(editor.state.renamingLayer).toBe(a.id)
  })
  it.each(['selection-return', 'page-return', 'edit-undo', 'document', 'busy', 'interaction'])('latches stale session across %s', reason => {
    const { editor, a } = fixture(); requestBatchRename(editor); const opened = batchRenameSnapshot(editor)!
    if (reason === 'selection-return') { const selection = editor.state.selection; editor.select([a.id]); editor.select(selection) }
    if (reason === 'page-return') { const page = editor.state.page; editor.set({ page: 'other' }); editor.set({ page }) }
    if (reason === 'edit-undo') { editor.update([a.id], { opacity: .5 }); editor.undo() }
    if (reason === 'document') editor.load(blank())
    if (reason === 'busy') { editor.set({ busy: true }); editor.set({ busy: false }) }
    if (reason === 'interaction') { editor.begin('drag'); editor.set({ message: 'drag' }); editor.cancel() }
    expect(batchRenameSnapshot(editor)?.stale).toBe(true); expect(batchRenameIsCurrent(editor, opened)).toBe(false)
    closeBatchRename(editor)
  })
})
