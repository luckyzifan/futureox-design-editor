import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, WorkspaceDocument } from './desktop'

const sessions: DesktopSession[] = []
const ok = { status: 'ok' } as const
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function fixture(known = true) {
  vi.useFakeTimers()
  const editor = new Editor(blank())
  const stringify = known ? JSON.stringify : (document: unknown) =>
    JSON.stringify(Object.fromEntries(Object.entries(document as Record<string, unknown>).reverse()))
  const encode = vi.fn(async (document: unknown) => stringify(document))
  const commit = vi.fn(async ({ documentJson }: { documentJson: string }) => {
    const document = JSON.parse(documentJson)
    return { ...ok, id: document.id, name: document.name, revision: 1, hash: 'saved', deleted: false, updatedAt: 1 }
  })
  const bridge = {
    version: 1, documentCodec: { ...(known ? { encoding: 'json-stringify-v1' } : {}), encode, decode: async (json: string) => JSON.parse(json) },
    workspace: { commit }, setDirty: async () => {}, clearRecovery: async () => ok, writeRecovery: async () => ok,
  } as unknown as DesktopBridge
  const session = new DesktopSession(bridge, editor, async () => 'discard')
  sessions.push(session)
  const source = blank('Imported 中文')
  const rectangle = node('rectangle', 0, 0, 50, 30)
  source.nodes[rectangle.id] = rectangle
  source.pages[0].children = [rectangle.id]
  return { editor, source, encode, commit, session, stringify,
    recover: () => (session as unknown as { updateRecovery(): Promise<void> }).updateRecovery() }
}
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); vi.restoreAllMocks() })

test('import saves the certified current bytes without encoding again and stays dirty until durable acknowledgement', async () => {
  const f = fixture()
  let finish!: (value: WorkspaceDocument & typeof ok) => void
  f.commit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const replacing = f.session.replace(f.source)
  await flush()
  expect(f.commit).toHaveBeenCalledTimes(1)
  const submitted = f.commit.mock.calls[0][0].documentJson
  expect(submitted).toBe(JSON.stringify(f.editor.state.doc))
  expect(f.encode).not.toHaveBeenCalled()
  expect(f.session.dirty).toBe(true)
  finish({ ...ok, id: f.editor.state.doc.id, name: f.editor.state.doc.name, revision: 1, hash: 'saved', deleted: false, updatedAt: 1 })
  expect(await replacing).toBe(true)
  expect(f.session.dirty).toBe(false)
  expect(f.editor.canUndo).toBe(false)
})

test('an unknown custom codec still independently encodes the imported current snapshot', async () => {
  const f = fixture(false)
  expect(await f.session.replace(f.source)).toBe(true)
  expect(f.encode).toHaveBeenCalledTimes(1)
  expect(f.commit.mock.calls[0][0].documentJson).toBe(f.stringify(f.editor.state.doc))
  expect(f.session.dirty).toBe(false)
})

test.each(['versioned-same-root', 'replacement-owner'] as const)(
  'import adoption listener %s invalidates current encoded bytes before the first save',
  async mutation => {
    const f = fixture()
    let handled = false
    const unsubscribe = f.editor.subscribe(() => {
      if (handled || f.editor.state.doc.id !== f.source.id) return
      handled = true
      if (mutation === 'versioned-same-root') {
        f.editor.state.doc.name = 'Edited during import'
        f.editor.set({ version: f.editor.state.version + 1 })
      } else f.editor.set({ doc: { ...f.editor.state.doc, name: 'Edited during import' } })
    })
    try {
      expect(await f.session.replace(f.source)).toBe(true)
      expect(handled).toBe(true)
      expect(f.encode).toHaveBeenCalledTimes(1)
      expect(JSON.parse(f.commit.mock.calls[0][0].documentJson).name).toBe('Edited during import')
      expect(f.session.dirty).toBe(false)
    } finally { unsubscribe() }
  },
)

test('a later versioned mutation of the imported root cannot reuse the first-save bytes', async () => {
  const f = fixture()
  expect(await f.session.replace(f.source)).toBe(true)
  expect(f.encode).not.toHaveBeenCalled()
  f.editor.state.doc.name = 'Later edit'
  f.editor.set({ version: f.editor.state.version + 1 })
  await f.recover()
  expect(f.encode).toHaveBeenCalledTimes(1)
  expect(f.commit).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.commit.mock.calls[1][0].documentJson).name).toBe('Later edit')
})

test('edits arriving during the certified first save remain dirty and get their own bytes', async () => {
  const f = fixture()
  let finish!: (value: WorkspaceDocument & typeof ok) => void
  f.commit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const replacing = f.session.replace(f.source)
  await flush()
  const submitted = JSON.parse(f.commit.mock.calls[0][0].documentJson)
  f.editor.change('rename after import', draft => { draft.name = 'Newer unsaved edit' })
  finish({ ...ok, id: submitted.id, name: submitted.name, revision: 1, hash: 'saved', deleted: false, updatedAt: 1 })
  expect(await replacing).toBe(true)
  expect(f.session.dirty).toBe(true)
  await f.recover()
  expect(f.encode).toHaveBeenCalledTimes(1)
  expect(f.commit).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.commit.mock.calls[1][0].documentJson).name).toBe('Newer unsaved edit')
  f.editor.undo()
  expect(f.editor.state.doc.name).toBe(submitted.name)
  f.editor.redo()
  expect(f.editor.state.doc.name).toBe('Newer unsaved edit')
})
