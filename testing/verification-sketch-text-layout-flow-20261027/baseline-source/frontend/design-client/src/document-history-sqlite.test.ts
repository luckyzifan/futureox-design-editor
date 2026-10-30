import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Editor } from './engine'
import { blank } from './model'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, WorkspaceBridge } from './desktop'
import { createDocumentHistory } from './document-history'
import { diffDocuments } from './document-diff'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const enabled = !!process.env.FUTUREOX_BACKEND_TEST_BINARY

test.skipIf(!enabled)('actual SQLite history: diff, stale CAS, restore, reopen, metadata, and independent editing undo', async () => {
  const { Sidecar } = await import(new URL('../../design-desktop/src/sidecar.mjs', import.meta.url).href)
  const directory = await mkdtemp(path.join(tmpdir(), 'futureox-history-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') })
  cleanup.push(() => sidecar.stop())
  const request = async (method: string, params: unknown) => {
    try { const result = await sidecar.request(method, params); return { status: 'ok' as const, ...result, ...(result.document ? { documentJson: JSON.stringify(result.document) } : {}) } }
    catch (e) { const error = e as { code: string; message: string }; return { status: error.code === 'WORKSPACE_CONFLICT' ? 'conflict' as const : 'error' as const, code: error.code, message: error.message } }
  }
  const workspace: WorkspaceBridge = {
    list: p => request('workspace.list', p), open: p => request('workspace.open', p), revisions: p => request('workspace.revisions', p), restore: p => request('workspace.restore', p), trash: p => request('workspace.trash', p),
    commit: p => request('workspace.commit', { document: JSON.parse(p.documentJson), expectedRevision: p.expectedRevision, mutationId: p.mutationId }),
  }
  const bridge = { workspace, version: 1, readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }), clearRecovery: async () => ({ status: 'ok' }), setDirty: async () => {}, renderPolicy: { cpuOnly: true } } as unknown as DesktopBridge
  const doc = blank('First saved version')
  doc.fdCompatibility = { contractVersion: 1, requiredCapabilities: [], extensions: { 'org.example/history': { label: 'preserve' } } }
  const editor = new Editor(doc); cleanup.push(() => editor.dispose())
  const session = new DesktopSession(bridge, editor, async () => 'discard'); cleanup.push(() => session.dispose())
  await session.start(); expect(await session.save()).toBe(true)
  editor.change('Rename', d => { d.name = 'Second version' }); expect(await session.save()).toBe(true)
  const history = createDocumentHistory(session), id = editor.state.doc.id
  expect((await history.list(id)).entries.map(e => e.revision)).toEqual([2, 1])
  const first = await history.load(id, 1), second = await history.load(id, 2)
  expect(diffDocuments(first!.document, second!.document)).toContainEqual(expect.objectContaining({ field: '名称', before: 'First saved version', after: 'Second version' }))
  const external = { ...second!.document, name: 'Concurrent external version' }
  await sidecar.request('workspace.commit', { document: external, expectedRevision: 2, mutationId: 'external_history' })
  expect(await history.restore(id, 1, 2)).toBe(false)
  expect(editor.state.doc.name).toBe('Second version')
  expect((await sidecar.request('workspace.open', { id })).revision).toBe(3)
  expect(await history.restore(id, 1, 3)).toMatchObject({ restored: true, revision: 4 })
  expect(editor.state.doc.name).toBe('First saved version')
  expect(editor.state.doc.fdCompatibility).toEqual(doc.fdCompatibility)
  expect(editor.canUndo).toBe(false)
  editor.change('New edit', d => { d.name = 'After restore' }); editor.undo()
  expect(editor.state.doc.name).toBe('First saved version')
  expect((await history.list(id)).entries.map(e => e.revision)).toEqual([4, 3, 2, 1])
  expect((await history.load(id, 3))?.document.name).toBe('Concurrent external version')
  await sidecar.stop()
  const reopenedSidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') })
  cleanup.push(() => reopenedSidecar.stop())
  const reopened = await reopenedSidecar.request('workspace.open', { id })
  expect(reopened.revision).toBe(4); expect(reopened.document.fdCompatibility).toEqual(doc.fdCompatibility)
})
