import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Editor } from '../engine'
import { blank } from '../model'
import { DesktopSession } from '../desktop-session'
import type { DesktopBridge, WorkspaceBridge } from '../desktop'
import { createWorkspaceAutomationRenderer } from './workspace-bridge'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const enabled = !!process.env.FUTUREOX_BACKEND_TEST_BINARY
async function fixture() {
  // Runtime imports keep native-only Node modules outside renderer dependencies.
  const { Sidecar } = await import(new URL('../../../design-desktop/src/sidecar.mjs', import.meta.url).href)
  const { WorkspaceAutomationHost } = await import(new URL('../../../design-desktop/src/workspace-automation.mjs', import.meta.url).href)
  const directory = await mkdtemp(path.join(tmpdir(), 'futureox-editor-mcp-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') })
  cleanup.push(() => sidecar.stop())
  const request = async (method: string, params: unknown) => {
    try { const result = await sidecar.request(method, params); return { status: 'ok' as const, ...result, ...(result.document ? { documentJson: JSON.stringify(result.document) } : {}) } }
    catch (error) { const failure = error as { code: string; message: string }; return { status: 'error' as const, code: failure.code, message: failure.message } }
  }
  const commits: Parameters<WorkspaceBridge['commit']>[0][] = []
  const workspace: WorkspaceBridge = {
    list: params => request('workspace.list', params), open: params => request('workspace.open', params), revisions: params => request('workspace.revisions', params), restore: params => request('workspace.restore', params), trash: params => request('workspace.trash', params),
    commit: params => { commits.push(params); return request('workspace.commit', { document: JSON.parse(params.documentJson), expectedRevision: params.expectedRevision, mutationId: params.mutationId }) },
  }
  const bridge = { workspace, version: 1, readRecovery: async () => ({ status: 'cancelled' }), writeRecovery: async () => ({ status: 'ok' }), clearRecovery: async () => ({ status: 'ok' }), setDirty: async () => {}, renderPolicy: { cpuOnly: true } } as unknown as DesktopBridge
  const editor = new Editor(blank('Actual Editor and SQLite')); cleanup.push(() => editor.dispose())
  const session = new DesktopSession(bridge, editor, async () => 'cancel'); cleanup.push(() => session.dispose())
  await session.start(); expect(await session.save()).toBe(true)
  const renderer = createWorkspaceAutomationRenderer(editor, { inspect: () => ({ storageRevision: session.status.revision ?? null, dirty: session.dirty, busy: session.status.busy }),
    execute: (method, params, guard, signal) => { if (method === 'settings.get' || method === 'settings.update') throw new Error('Not part of this workspace test'); return session.automationWorkspace(method, params, guard, signal) } })
  const root = {}, host = new WorkspaceAutomationHost({ getRoot: () => root, status: () => ({ displayName: 'Temporary SQLite' }), storage: (method: string, params: unknown) => sidecar.request(method, params), dispatch: renderer.execute, confirm: async () => true })
  const grant = await host.grant('test-owner', { workspace: 'write' })
  const guard = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const call = (method: string, params: unknown) => host.execute({ kind: 'execute', sessionId: 'test-owner', scope: 'read', ...guard(), deadline: Date.now() + 10000, request: { method, params, ...guard() } }, new AbortController().signal)
  return { sidecar, editor, session, host, grant, guard, commits, call }
}
it.skipIf(!enabled)('rejects every malformed mutation at host and DesktopSession without poisoning actual SQLite/manual Save', async () => {
  const f = await fixture()
  for (const mutationId of ['', 'save:1', 'save.1', 'space id', 'é', 'x'.repeat(129), null, 7]) {
    f.editor.change('Keep draft savable', document => { document.name = `After invalid ${JSON.stringify(mutationId)}` })
    const before = f.commits.length, expectedStorageRevision = f.session.status.revision
    await expect(f.call('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision, mutationId })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(f.session.automationWorkspace('workspace.save', { expectedStorageRevision, mutationId }, f.guard(), new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(f.commits.length).toBe(before); expect(await f.session.save()).toBe(true); expect(f.session.dirty).toBe(false)
    expect(f.commits.at(-1)?.mutationId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  }
  f.editor.change('Valid limit', document => { document.name = '128-character mutation accepted' })
  const result = await f.call('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision: f.session.status.revision, mutationId: 'x'.repeat(128) })
  expect(result.result.storageRevision).toBe(10); expect(f.session.dirty).toBe(false)
  expect((await f.sidecar.request('workspace.open', { id: f.editor.state.doc.id })).document.name).toBe('128-character mutation accepted')
})
it.skipIf(!enabled)('pages all 101 actual durable revisions with no omissions and correct exclusive boundaries', async () => {
  const f = await fixture(), document = structuredClone(f.editor.state.doc)
  for (let revision = 1; revision < 101; revision++) {
    document.name = `Revision ${revision + 1}`
    await f.sidecar.request('workspace.commit', { document, expectedRevision: revision, mutationId: `history_${revision}` })
  }
  const status = (await f.call('workspace.root.status', {})).result
  const params = { rootHandle: f.grant.rootHandle, documentHandle: status.activeDocumentHandle }
  const first = (await f.call('workspace.revisions', params)).result
  expect(first.revisions.map((row: { storageRevision: number }) => row.storageRevision)).toEqual(Array.from({ length: 100 }, (_, index) => 101 - index))
  expect(first).toMatchObject({ hasMore: true, nextBeforeRevision: 2 })
  const last = (await f.call('workspace.revisions', { ...params, beforeRevision: first.nextBeforeRevision })).result
  expect(last.revisions.map((row: { storageRevision: number }) => row.storageRevision)).toEqual([1])
  expect(last).toMatchObject({ hasMore: false, nextBeforeRevision: null })
})
