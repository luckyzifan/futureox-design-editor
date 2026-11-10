import { expect, test, vi } from 'vitest'
import React from 'react'
import { blank } from './model'
const mock = vi.hoisted(() => ({ api: null as any }))
vi.mock('./document-history', () => ({ createDocumentHistory: () => mock.api }))
import { DocumentHistoryDialog } from './DocumentHistoryDialog'
function find(tree: any, predicate: (v: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const match = find(child, predicate); if (match) return match }
}
function text(tree: any): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : [tree?.props?.children].flat(Infinity).map(v => v ? text(v) : '').join('') }
function fixture(unsaved = false, beforeLocalRestore?: () => () => boolean) {
  const doc = blank(), api = {
    route: 'local', list: vi.fn(async () => ({ entries: [{ revision: 2, createdAt: 2 }, { revision: 1, createdAt: 1 }], hasMore: false })),
    load: vi.fn(async (_id: string, revision: number) => ({ document: { ...doc, name: `Version ${revision}` }, revision })),
    restore: vi.fn(async () => ({ document: doc, revision: 3, adopted: false, restored: true })),
  }
  mock.api = api
  const slots: any[] = []; let cursor = 0
  const hooks = { useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: any) => slots[i] = v] }, useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial } }, useMemo(fn: any) { cursor++; return fn() }, useEffect() { cursor++ }, useLayoutEffect() { cursor++ } }
  const onClose = vi.fn(), onLocalAdopt = vi.fn(async () => true)
  const render = () => { cursor = 0; const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, old = internals.H; internals.H = hooks; try { return DocumentHistoryDialog({ documentId: doc.id, documentName: doc.name, unsaved, beforeLocalRestore, onClose, onLocalAdopt }) } finally { internals.H = old } }
  const button = (name: string) => find(render(), v => v.type === 'button' && (v.props['aria-label'] === name || text(v) === name))
  const ready = async () => { button('刷新').props.onClick(); await vi.waitFor(() => expect(button('恢复版本 1')).toBeDefined()) }
  return { doc, api, render, button, ready, onClose, onLocalAdopt }
}
test('shared history compares snapshots, confirms unsaved discard and passes the viewed CAS', async () => {
  const f = fixture(true); await f.ready()
  f.button('比较版本 2').props.onClick()
  await vi.waitFor(() => expect(text(f.render())).toContain('版本 1 → 2'))
  expect(text(f.render())).toContain('Version 1 → Version 2')
  f.button('恢复版本 1').props.onClick(); expect(f.api.restore).not.toHaveBeenCalled()
  f.button('保留修改，取消恢复').props.onClick(); expect(f.api.restore).not.toHaveBeenCalled()
  f.button('恢复版本 1').props.onClick(); f.button('丢弃修改并恢复').props.onClick()
  await vi.waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
  expect(f.api.restore).toHaveBeenCalledWith(f.doc.id, 1, 2)
})
test('restore failure remains visible and repeated clicks are locked synchronously', async () => {
  const f = fixture(); await f.ready()
  let reject!: (e: Error) => void
  f.api.restore.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  const click = f.button('恢复版本 1').props.onClick
  click(); click(); expect(f.api.restore).toHaveBeenCalledTimes(1)
  reject(new Error('Storage unavailable'))
  await vi.waitFor(() => expect(text(f.render())).toContain('Storage unavailable'))
  expect(f.onClose).not.toHaveBeenCalled(); expect(f.onLocalAdopt).not.toHaveBeenCalled()
})
test('new input during restore preserves current editor, pending input blocks writes', async () => {
  let current = true
  const f = fixture(false, () => () => current); await f.ready()
  f.api.restore.mockImplementation(async () => { current = false; return { document: f.doc, revision: 3, adopted: false, restored: true } })
  f.button('恢复版本 1').props.onClick()
  await vi.waitFor(() => expect(text(f.render())).toContain('当前画布已保留'))
  expect(f.onLocalAdopt).not.toHaveBeenCalled()
  const g = fixture(false, () => { throw new Error('Finish pending input') }); await g.ready()
  g.button('恢复版本 1').props.onClick()
  await vi.waitFor(() => expect(text(g.render())).toContain('Finish pending input'))
  expect(g.api.restore).not.toHaveBeenCalled()
})
