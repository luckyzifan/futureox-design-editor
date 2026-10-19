import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { WorkspaceRoots } from '../../src/workspace-roots.mjs'
import { Sidecar } from '../../src/sidecar.mjs'

const binary = process.env.CORE_DESKTOP_SIDECAR
if (!binary || !path.isAbsolute(binary)) throw new Error('CORE_DESKTOP_SIDECAR must identify the actual owned Rust binary')
const evidenceDirectory = process.env.CORE_WORKSPACE_EVIDENCE_DIR
if (evidenceDirectory && !path.isAbsolute(evidenceDirectory)) throw new Error('Evidence directory must be absolute')
const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex')
console.log(`WORKSPACE_SELECTION_BINARY_SHA256 ${binaryHash}`)

async function fixture(t) {
  const parent = evidenceDirectory || os.tmpdir()
  await mkdir(parent, { recursive: true })
  const base = await realpath(await mkdtemp(path.join(parent, 'sqlite-roots-')))
  const profile = path.join(base, 'legacy-default'), first = path.join(base, 'design-one'), second = path.join(base, 'design-two')
  await Promise.all([profile, first, second].map(root => mkdir(root)))
  const selections = [], choices = [], prompts = [], children = new Set()
  const dialog = {
    async showOpenDialog() { const value = selections.shift(); return value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] } },
    async showMessageBox(prompt) { prompts.push(prompt); return { response: choices.shift() ?? prompt.cancelId } },
  }
  const start = config => { const child = new Sidecar(binary, config.recoveryDir, { catalogDb: config.catalogDb, workspaceDb: config.workspaceDb, timeoutMs: 15000 }); children.add(child); return child }
  const stop = async child => { assert.equal(await child.stop(), true); children.delete(child) }
  const probe = async config => {
    const child = start(config)
    try { await child.request('health'); await child.request('workspace.list'); await child.request('catalog.list') }
    finally { await stop(child) }
  }
  const roots = new WorkspaceRoots({ profileRoot: profile, dialog, probe })
  await roots.startup({ isolated: true })
  t.after(async () => {
    for (const child of children) await child.stop()
    if (!evidenceDirectory) await rm(base, { recursive: true, force: true })
  })
  return { base, profile, first, second, roots, selections, choices, prompts, dialog, probe, start, stop }
}
const document = name => ({ schemaVersion: 6, id: randomUUID(), name, pages: [
  { id: randomUUID(), name: '封面', background: '#ffffff', children: [] },
  { id: randomUUID(), name: '第二页', background: '#e0e0ff', children: [] },
], nodes: {}, extensionData: { exact: [0.125, 1e-12, '离线工作区 🧪'] } })
const commit = (child, document, expectedRevision = null) => child.request('workspace.commit', { document, expectedRevision, mutationId: randomUUID() })

test('real Rust SQLite: two selected directory workspaces preserve multiple canvas files/pages across process restarts and isolate legacy data', async t => {
  const f = await fixture(t)
  const original = f.roots.current
  const legacy = document('原默认设计')
  let child = f.start(f.roots.config(original)); await commit(child, legacy); await f.stop(child)
  const legacyBefore = createHash('sha256').update(await readFile(path.join(f.profile, 'workspace-v1.sqlite3'))).digest('hex')
  f.selections.push(f.first)
  const staged = await f.roots.stage(); const firstRoot = await f.roots.take(staged.selectionId)
  assert.equal((await f.roots.saved()), undefined, 'Staging cannot persist the selected root')
  await f.roots.persist(firstRoot)
  child = f.start(f.roots.config(firstRoot))
  const one = document('画布文件一'), two = document('画布文件二')
  assert.equal((await child.request('workspace.list')).documents.length, 0)
  await commit(child, one); await commit(child, two)
  const revisionTwo = { ...one, name: '画布文件一 · 第二版' }
  await commit(child, revisionTwo, 1)
  assert.equal((await child.request('workspace.list')).documents.length, 2)
  await assert.rejects(child.request('workspace.open', { id: legacy.id }), error => error.code === 'WORKSPACE_NOT_FOUND')
  await f.stop(child)
  const resumed = new WorkspaceRoots({ profileRoot: f.profile, dialog: f.dialog, probe: f.probe })
  f.choices.push(0) // Explicitly continue last workspace after an actual backend stop.
  const restoredRoot = await resumed.startup()
  child = f.start(resumed.config(restoredRoot))
  assert.deepEqual((await child.request('workspace.open', { id: one.id })).document, revisionTwo)
  assert.deepEqual((await child.request('workspace.open', { id: two.id })).document, two)
  assert.equal((await child.request('workspace.revisions', { id: one.id })).revisions.length, 2)
  await f.stop(child)
  f.selections.push(f.second)
  const other = await resumed.stage(); const secondRoot = await resumed.take(other.selectionId)
  child = f.start(resumed.config(secondRoot))
  assert.equal((await child.request('workspace.list')).documents.length, 0)
  const otherDocument = { ...one, name: '另一目录中的同 ID 设计' }
  await commit(child, otherDocument)
  assert.deepEqual((await child.request('workspace.open', { id: one.id })).document, otherDocument)
  await f.stop(child)
  child = f.start(resumed.config(restoredRoot))
  assert.deepEqual((await child.request('workspace.open', { id: one.id })).document, revisionTwo)
  await f.stop(child)
  assert.equal(createHash('sha256').update(await readFile(path.join(f.profile, 'workspace-v1.sqlite3'))).digest('hex'), legacyBefore, 'Selecting other roots must leave legacy SQLite bytes unchanged')
  const legacySelection = await resumed.stage(true); const legacyRoot = await resumed.take(legacySelection.selectionId)
  child = f.start(resumed.config(legacyRoot))
  assert.deepEqual((await child.request('workspace.open', { id: legacy.id })).document, legacy)
  assert.equal((await child.request('workspace.list')).documents.length, 1)
  await f.stop(child)
  const evidence = { binarySha256: binaryHash, original: original.storagePath, first: firstRoot.storagePath, second: secondRoot.storagePath, legacyId: legacy.id, firstIds: [one.id, two.id], firstPageCounts: [one.pages.length, two.pages.length], firstRevision: 2, isolationSameId: one.id, legacyBytesUnchangedDuringSwitch: true, nativeGuiExecuted: false }
  await writeFile(path.join(f.base, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(`WORKSPACE_SELECTION_SQLITE_EVIDENCE ${f.base}`)
})

test('real Rust SQLite: future schema fails staging and original selection and database remain accessible', async t => {
  const f = await fixture(t)
  const current = f.roots.current; await f.roots.persist(current)
  const originalDoc = document('保留原数据库')
  let child = f.start(f.roots.config(current)); await commit(child, originalDoc); await f.stop(child)
  const before = await readFile(f.roots.selectionFile, 'utf8')
  const target = await f.roots.prepare(f.first)
  child = f.start(f.roots.config(target)); await child.request('workspace.list'); await f.stop(child)
  const targetDb = f.roots.config(target).workspaceDb
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=999"); c.close()', targetDb], { stdio: ['ignore', 'pipe', 'pipe'] })
  f.selections.push(f.first)
  await assert.rejects(f.roots.stage(), error => error.code === 'WORKSPACE_UNAVAILABLE' && error.message.includes('WORKSPACE_FUTURE_SCHEMA'))
  assert.equal(await readFile(f.roots.selectionFile, 'utf8'), before)
  assert.equal(f.roots.pending, undefined)
  child = f.start(f.roots.config(current))
  assert.deepEqual((await child.request('workspace.open', { id: originalDoc.id })).document, originalDoc)
  await f.stop(child)
  await writeFile(path.join(f.base, 'evidence.json'), JSON.stringify({ binarySha256: binaryHash, rejectedCode: 'WORKSPACE_UNAVAILABLE', rejectedReason: 'WORKSPACE_FUTURE_SCHEMA', originalSelectionUnchanged: true, originalDocumentId: originalDoc.id, nativeGuiExecuted: false }, null, 2))
  console.log(`WORKSPACE_SELECTION_SQLITE_FAILURE_EVIDENCE ${f.base}`)
})
