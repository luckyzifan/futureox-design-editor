import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Sidecar } from '../src/sidecar.mjs'
import { registerAutomationBridge } from '../src/automation-bridge.mjs'
import { APP_URL, assertSender } from '../src/security.mjs'

test('trusted automation IPC persists only allowlisted preferences and metadata in actual SQLite', { skip: !process.env.FUTUREOX_BACKEND_TEST_BINARY }, async t => {
  // Native workspace admission deliberately rejects symlink ancestors. Resolve
  // only this owned fixture; do not weaken production path validation.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'design-automation-storage-test-')))
  const options = { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') }
  let backend = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), options)
  const handlers = new Map(), frame = { url: APP_URL }, window = { isDestroyed: () => false, webContents: { mainFrame: frame, send() {} } }
  const bridge = registerAutomationBridge({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getWindow: () => window, assertSender, dialog: {}, clipboard: {}, storage: (method, value) => backend.request(method, value), audit: entry => backend.request('automation.audit.append', { event: entry.event, method: entry.method, documentId: entry.documentId, session: entry.session, revision: entry.revision, source: entry.source, summary: entry.summary, status: 'succeeded' }) })
  t.after(async () => { await bridge.close(); await backend.stop(); await rm(directory, { recursive: true, force: true }) })
  const event = { sender: window.webContents, senderFrame: frame }
  const call = (method, value) => handlers.get(`design-desktop:automation-${method}`)(event, value)
  assert.equal((await backend.request('health')).workspaceAvailable, true, 'the actual native workspace must be admitted before storage assertions')
  assert.equal((await call('config')).preferredScope, 'read')
  assert.equal((await call('configure', { retentionDays: 7, preferredScope: 'write' })).retentionDays, 7)
  assert.equal((await call('storage-status')).authorizationPersisted, false)
  assert.throws(() => call('configure', { token: 'never-save-this' }), /Invalid automation preferences/)
  assert.throws(() => call('audit-history', { limit: 101 }), /Invalid audit history/)
  const audit = await backend.request('automation.audit.append', { event: 'execute', method: 'node.update', requestId: 'request-1', documentId: 'doc-1', session: 2, revision: 7, status: 'succeeded', scope: 'write', durationMs: 3 })
  assert.equal(audit.recorded, true)
  assert.equal((await call('audit-history', { limit: 10 })).entries[0].method, 'node.update')
  call('register', { documentId: 'doc-1', session: 2, name: 'Local design', methods: [] })
  assert.equal(call('record-edit', { documentId: 'doc-1', session: 2, revision: 8, source: 'user', kind: 'edit', summary: 'Move layer' }).accepted, true)
  assert.equal(call('record-edit', { documentId: 'doc-1', session: 2, revision: 9, source: 'automation', kind: 'undo', summary: 'API undo' }).accepted, true)
  await bridge.close()
  const userEdits = await call('audit-history', { limit: 10, documentId: 'doc-1', source: 'user' })
  assert.equal(userEdits.entries.length, 1)
  assert.equal(userEdits.entries[0].revision, 8)
  assert.equal(userEdits.entries[0].summary, 'Move layer')
  await backend.stop()
  backend = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), options)
  assert.equal((await call('config')).preferredScope, 'write')
  assert.equal((await call('audit-history', { limit: 10, documentId: 'doc-1', source: 'automation' })).entries[0].revision, 9)
  assert.equal(call('status').enabled, false, 'persisted preferred scope never re-enables a grant')
})
