import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, uid } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, DesktopResult, WorkspaceBridge, WorkspaceOpened } from './desktop'

const sessions: DesktopSession[] = []
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); vi.unstubAllGlobals(); vi.useRealTimers() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function clipboardRead() {
  const read = deferred<DesktopResult<{ text: string }>>()
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: () => read.promise } } })
  return read
}

test('late clipboard read cannot paste into a different page with the same empty selection', async () => {
  const document = blank('two pages'), second = { id: uid(), name: 'Second', children: [], background: '#ffffff' }
  document.pages.push(second)
  const editor = new Editor(document), read = clipboardRead()
  const pending = dispatchEditorCommand(editor, 'paste')
  editor.switchPage(second.id)
  read.resolve({ status: 'ok', text: 'late text' })
  await pending
  expect(editor.state.doc.pages.find((page) => page.id === second.id)!.children).toEqual([])
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
  editor.dispose()
})

test('late clipboard read cannot splice a document mutation into a new uncommitted drag', async () => {
  const document = blank('gesture'), shape = node('rectangle', 10, 20, 40, 30)
  document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  const editor = new Editor(document), read = clipboardRead()
  editor.select([shape.id])
  const pending = dispatchEditorCommand(editor, 'paste')
  editor.begin('drag'); editor.preview({ [shape.id]: { transform: [1, 0, 0, 1, 200, 100] } })
  read.resolve({ status: 'ok', text: 'late text' })
  await pending
  expect(Object.keys(editor.state.doc.nodes)).toEqual([shape.id])
  expect(editor.interactionActive).toBe(true)
  editor.cancel()
  expect(editor.state.doc.nodes[shape.id].transform[4]).toBe(10)
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})

test.each(['paste', 'cut'] as const)('a modal opened during asynchronous %s preserves the original selection and document', async (command) => {
  const document = blank('modal boundary'), shape = node('rectangle', 10, 20, 40, 30)
  document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  const editor = new Editor(document), gate = deferred<{ status: 'ok'; text: string }>()
  editor.select([shape.id])
  let modal = false
  vi.stubGlobal('document', { activeElement: null, querySelector: () => modal ? {} : null })
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: () => gate.promise, write: () => gate.promise } } })
  const before = editor.state.doc, pending = dispatchEditorCommand(editor, command)
  modal = true
  gate.resolve({ status: 'ok', text: 'late text' })
  await pending
  expect(editor.state.doc).toBe(before)
  expect(editor.state.selection).toEqual([shape.id])
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})

test('startup recovery can be saved without overwriting an existing SQLite head or entering a permanent create-only conflict', async () => {
  vi.useFakeTimers()
  const stored = blank('existing durable version'), recovered = { ...stored, name: 'recovered unsaved changes' }
  const rows = new Map<string, WorkspaceOpened>([[stored.id, { id: stored.id, name: stored.name, revision: 4, updatedAt: 1, deleted: false, hash: 'stored', documentJson: JSON.stringify(stored) }]])
  const ok = { status: 'ok' } as const
  const workspace: WorkspaceBridge = {
    list: async () => ({ ...ok, documents: [...rows.values()] }),
    open: async ({ id }) => rows.has(id) ? { ...ok, ...rows.get(id)! } : { status: 'error', code: 'WORKSPACE_NOT_FOUND', message: 'missing' },
    commit: async (request) => {
      const doc = JSON.parse(request.documentJson), current = rows.get(doc.id)
      if ((current?.revision ?? null) !== request.expectedRevision) return { status: 'conflict', code: 'WORKSPACE_CONFLICT', message: 'create-only conflict' }
      const row = { id: doc.id, name: doc.name, revision: (current?.revision || 0) + 1, updatedAt: 2, deleted: false, hash: 'next', documentJson: request.documentJson }
      rows.set(doc.id, row); return { ...ok, ...row }
    },
    trash: async () => { throw Error('unused') }, revisions: async () => ({ ...ok, revisions: [] }), restore: async () => { throw Error('unused') },
  }
  const bridge = { version: 1, workspace, renderPolicy: { cpuOnly: true },
    readRecovery: async () => ({ ...ok, documentJson: JSON.stringify(recovered), displayName: recovered.name, recoveryHandle: 'recovery' }),
    acceptRecovery: async () => ok, writeRecovery: async () => ok, clearRecovery: async () => ok, setDirty: async () => {},
  } as unknown as DesktopBridge
  const editor = new Editor(blank()), session = new DesktopSession(bridge, editor, async () => 'save')
  sessions.push(session)
  expect(await session.start()).toBe(true)
  expect(editor.state.doc.name).toContain('recovered unsaved changes')
  expect(await session.save()).toBe(true)
  expect(session.status.conflict).toBe(false)
  expect([...rows.values()].some((row) => row.name.includes('recovered unsaved changes'))).toBe(true)
  expect(rows.get(stored.id)?.name).toBe('existing durable version')
  editor.dispose()
})
