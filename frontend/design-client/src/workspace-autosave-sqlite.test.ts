import { afterEach, expect, test } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Editor } from './engine'
import { blank, node } from './model'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, WorkspaceBridge } from './desktop'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
test.skipIf(!process.env.FUTUREOX_BACKEND_TEST_BINARY)('real Editor and SQLite persist full property undo after a held native read rejects autosave as BUSY', async () => {
  const { Sidecar } = await import(new URL('../../design-desktop/src/sidecar.mjs', import.meta.url).href)
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'futureox-undo-autosave-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), {
    workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3'),
  })
  cleanup.push(() => sidecar.stop())
  const request = async (method: string, params: unknown) => {
    try {
      const result = await sidecar.request(method, params)
      return { status: 'ok' as const, ...result, ...(result.document ? { documentJson: JSON.stringify(result.document) } : {}) }
    } catch (cause) {
      const error = cause as { code: string; message: string }
      return { status: error.code === 'WORKSPACE_CONFLICT' ? 'conflict' as const : 'error' as const, code: error.code, message: error.message }
    }
  }
  // Model main.mjs's existing exclusive host gate around a real native read.
  // Editor/history and all admitted commits/reads use real WASM and SQLite.
  let holdRead = false, nativeReadBusy = false, releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  cleanup.push(() => releaseRead())
  const commits: Parameters<WorkspaceBridge['commit']>[0][] = []
  const workspace: WorkspaceBridge = {
    list: p => request('workspace.list', p), revisions: p => request('workspace.revisions', p),
    restore: p => request('workspace.restore', p), trash: p => request('workspace.trash', p),
    open: async p => {
      if (!holdRead) return request('workspace.open', p)
      nativeReadBusy = true
      try { const value = await request('workspace.open', p); await gate; return value }
      finally { nativeReadBusy = false }
    },
    commit: async p => {
      commits.push({ ...p })
      if (nativeReadBusy) return { status: 'error', code: 'BUSY', message: 'Another file operation is in progress' }
      return request('workspace.commit', { document: JSON.parse(p.documentJson), expectedRevision: p.expectedRevision, mutationId: p.mutationId })
    },
  }
  const bridge = { workspace, version: 1, readRecovery: async () => ({ status: 'cancelled' }),
    writeRecovery: async () => ({ status: 'ok' }), clearRecovery: async () => ({ status: 'ok' }), setDirty: async () => {},
    renderPolicy: { cpuOnly: true } } as unknown as DesktopBridge
  const doc = blank('Fractional X undo'), text = node('text', 75.85958862304688, 0, 120, 30)
  text.text = 'Preserve exact authored X'; doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
  const editor = new Editor(doc); cleanup.push(() => editor.dispose())
  const session = new DesktopSession(bridge, editor, async () => 'discard'); cleanup.push(() => session.dispose())
  await session.start()
  const saved = await session.save(); expect(saved, JSON.stringify(session.status)).toBe(true)
  const original = await workspace.open({ id: doc.id }); expect(original.status).toBe('ok')
  if (original.status !== 'ok') throw Error('Original durable snapshot unavailable')
  editor.change('X property', d => { d.nodes[text.id].transform[4] = 99.86 })
  await expect.poll(() => session.status, { timeout: 8000 }).toMatchObject({ dirty: false, revision: 2 })
  const edited = await workspace.open({ id: doc.id }); expect(edited.status).toBe('ok')
  if (edited.status !== 'ok') throw Error('Edited durable snapshot unavailable')
  expect(JSON.parse(edited.documentJson).nodes[text.id].transform[4]).toBe(99.86)
  holdRead = true; const reading = workspace.open({ id: doc.id })
  expect(nativeReadBusy).toBe(true)
  editor.undo(); expect(editor.state.doc.nodes[text.id].transform[4]).toBe(75.85958862304688)
  await expect.poll(() => commits.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3)
  expect(session.dirty).toBe(true)
  expect((await request('workspace.open', { id: doc.id })).documentJson).toBe(edited.documentJson)
  releaseRead(); await reading
  await expect.poll(() => session.status, { timeout: 8000 }).toMatchObject({ dirty: false, revision: 3, error: undefined })
  const restored = await request('workspace.open', { id: doc.id })
  expect(restored.documentJson).toBe(original.documentJson)
  expect(commits.at(-1)).toEqual(commits[2])
  expect(restored.revision).toBe(3)
  await sidecar.stop()
  const reopened = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), {
    workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3'),
  })
  cleanup.push(() => reopened.stop())
  const durable = await reopened.request('workspace.open', { id: doc.id })
  expect(JSON.stringify(durable.document)).toBe(original.documentJson)
  expect(durable.revision).toBe(3)
}, 20_000)
