import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, link, realpath, chmod } from 'node:fs/promises'
import { WorkspaceRoots, WORKSPACE_DIRECTORY, WORKSPACE_SELECTION } from '../src/workspace-roots.mjs'

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workspace-selection-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const profile = path.join(base, 'profile'), first = path.join(base, 'first'), second = path.join(base, 'second')
  await Promise.all([profile, first, second].map(root => mkdir(root)))
  const prompts = [], opens = [], choices = [], selected = [], probes = []
  const dialog = {
    async showMessageBox(prompt) { prompts.push(prompt); return { response: choices.shift() ?? prompt.cancelId } },
    async showOpenDialog(prompt) { opens.push(prompt); const result = selected.shift(); return result ? { canceled: false, filePaths: [result] } : { canceled: true, filePaths: [] } },
  }
  const roots = new WorkspaceRoots({ profileRoot: profile, dialog, probe: async config => probes.push(config) })
  return { base, profile, first, second, prompts, opens, choices, selected, probes, roots, dialog }
}

test('startup always asks, cancellation opens no database and does not silently choose default', async t => {
  const f = await fixture(t)
  assert.equal(await f.roots.startup(), undefined)
  assert.equal(f.prompts.length, 1)
  assert.equal(f.probes.length, 0)
  await assert.rejects(readFile(path.join(f.profile, WORKSPACE_SELECTION)), { code: 'ENOENT' })
  assert.deepEqual(f.prompts[0].buttons, ['选择本地目录…', '打开原默认工作区', '退出'])
})

test('cancelled folder picker returns to startup choices, then explicit default preserves legacy data', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.profile, 'legacy-design.fd'), 'legacy unchanged')
  f.choices.push(0, 1)
  const root = await f.roots.startup()
  assert.equal(root.storagePath, f.profile)
  assert.equal(f.prompts.length, 2)
  assert.equal(f.probes.length, 1)
  assert.equal(await readFile(path.join(f.profile, 'legacy-design.fd'), 'utf8'), 'legacy unchanged')
  assert.equal(JSON.parse(await readFile(path.join(f.profile, WORKSPACE_SELECTION), 'utf8')).kind, 'default')
})

test('chosen local directory stages distinct SQLite/recovery/catalog paths and is never a Git requirement', async t => {
  const f = await fixture(t)
  await f.roots.startup({ isolated: true })
  f.selected.push(f.first)
  const result = await f.roots.stage()
  assert.deepEqual(Object.keys(result).sort(), ['displayName', 'isDefault', 'selectionId', 'status'])
  assert.equal(result.displayName, 'first'); assert.equal(result.isDefault, false)
  assert.equal(f.roots.status().isDefault, true)
  await assert.rejects(readFile(path.join(f.profile, WORKSPACE_SELECTION)), { code: 'ENOENT' })
  const root = await f.roots.take(result.selectionId)
  const storage = path.join(f.first, WORKSPACE_DIRECTORY)
  assert.deepEqual(f.roots.config(root), { recoveryDir: path.join(storage, 'recovery-v1'), catalogDb: path.join(storage, 'catalog-v1.sqlite3'), workspaceDb: path.join(storage, 'workspace-v1.sqlite3') })
  assert.equal(f.probes.length, 1)
  assert.match(f.opens[0].title, /无需 Git/)
  await f.roots.persist(root)
  assert.equal(JSON.parse(await readFile(path.join(f.profile, WORKSPACE_SELECTION), 'utf8')).rootPath, f.first)
  await assert.rejects(f.roots.take(result.selectionId), { code: 'WORKSPACE_ROOT_STALE' })
})

test('restart offers last workspace but never opens it without explicit choice', async t => {
  const f = await fixture(t)
  await f.roots.startup({ isolated: true })
  const selected = await f.roots.prepare(f.first); await f.roots.persist(selected)
  const next = new WorkspaceRoots({ profileRoot: f.profile, dialog: f.dialog, probe: async config => f.probes.push(config) })
  assert.equal(await next.startup(), undefined)
  assert.equal(f.probes.length, 0)
  assert.deepEqual(f.prompts[0].buttons, ['继续上次工作区', '选择本地目录…', '打开原默认工作区', '退出'])
  f.choices.push(0)
  const resumed = await next.startup()
  assert.equal(resumed.storagePath, selected.storagePath)
})

test('choosing the legacy profile directly maps to original data rather than nested blank storage', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  f.selected.push(f.profile)
  const result = await f.roots.stage()
  assert.equal(result.isDefault, true)
  assert.equal((await f.roots.take(result.selectionId)).storagePath, f.profile)
  assert.equal(f.probes.length, 0)
})

test('arbitrary relative paths, files, unowned hidden directories, and database symlinks are rejected', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  await assert.rejects(f.roots.prepare('relative'))
  await writeFile(path.join(f.base, 'file'), 'file')
  await assert.rejects(f.roots.prepare(path.join(f.base, 'file')))
  await mkdir(path.join(f.second, WORKSPACE_DIRECTORY))
  await writeFile(path.join(f.second, WORKSPACE_DIRECTORY, 'keep.txt'), 'keep me')
  await assert.rejects(f.roots.prepare(f.second))
  assert.equal(await readFile(path.join(f.second, WORKSPACE_DIRECTORY, 'keep.txt'), 'utf8'), 'keep me')
  const first = await f.roots.prepare(f.first)
  const victim = path.join(f.base, 'victim'); await writeFile(victim, 'must not touch')
  await symlink(victim, path.join(first.storagePath, 'workspace-v1.sqlite3'))
  await assert.rejects(f.roots.verify(first))
  assert.equal(await readFile(victim, 'utf8'), 'must not touch')
})

test('database hardlinks, non-SQLite contents, WAL symlinks and recovery directory symlinks fail closed', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  const root = await f.roots.prepare(f.first), db = path.join(root.storagePath, 'workspace-v1.sqlite3')
  const victim = path.join(f.base, 'victim'); await writeFile(victim, 'SQLite format 3\0')
  await link(victim, db); await assert.rejects(f.roots.verify(root)); await rm(db)
  await writeFile(db, 'not SQLite'); await assert.rejects(f.roots.verify(root)); await rm(db)
  await symlink(victim, `${db}-wal`); await assert.rejects(f.roots.verify(root)); await rm(`${db}-wal`)
  await rm(path.join(root.storagePath, 'recovery-v1'), { recursive: true })
  await symlink(f.second, path.join(root.storagePath, 'recovery-v1'))
  await assert.rejects(f.roots.verify(root))
})

test('staged identity replacement and symlink retargeting cannot activate a different root', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  f.selected.push(f.first)
  const staged = await f.roots.stage()
  await rename(f.first, `${f.first}-old`); await mkdir(f.first)
  await assert.rejects(f.roots.take(staged.selectionId), { code: 'WORKSPACE_ROOT_STALE' })
  await rm(f.first, { recursive: true }); await symlink(`${f.first}-old`, f.first)
  await assert.rejects(f.roots.verify({ ...f.roots.current, rootPath: f.first }))
  await assert.rejects(readFile(path.join(f.profile, WORKSPACE_SELECTION)), { code: 'ENOENT' })
})

test('new selection/cancel invalidates earlier capability; expired capability cannot activate', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  f.selected.push(f.first); const old = await f.roots.stage()
  assert.deepEqual(await f.roots.stage(), { status: 'cancelled' })
  await assert.rejects(f.roots.take(old.selectionId), { code: 'WORKSPACE_ROOT_STALE' })
  f.selected.push(f.second); const next = await f.roots.stage()
  f.roots.pending.expires = Date.now() - 1
  await assert.rejects(f.roots.take(next.selectionId), { code: 'WORKSPACE_ROOT_STALE' })
})

test('open peer windows block both staging and activation without consuming a native folder choice', async t => {
  const f = await fixture(t); await f.roots.startup({ isolated: true })
  f.roots.canSwitch = () => false
  await assert.rejects(f.roots.stage(), { code: 'WORKSPACE_ROOT_PEERS' })
  assert.equal(f.opens.length, 0)
  await assert.rejects(f.roots.take('invalid'), { code: 'WORKSPACE_ROOT_PEERS' })
})

test('corrupt saved selection or missing prior directory requires explicit recovery choice', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.profile, WORKSPACE_SELECTION), '{bad json')
  f.choices.push(1)
  const root = await f.roots.startup()
  assert.equal(root.kind, 'default'); assert.match(f.prompts[0].detail, /无法读取/)
  const selected = await f.roots.prepare(f.first); await f.roots.persist(selected)
  await rename(f.first, `${f.first}-moved`)
  f.choices.push(0, 0, 2) // Last workspace fails; acknowledge; explicitly choose legacy.
  const next = await f.roots.startup()
  assert.equal(next.kind, 'default')
  assert.ok(f.prompts.some(prompt => prompt.title === '工作区未打开'))
})

test('SQLite probe failure leaves saved selection unchanged and does not return activation capability', async t => {
  const f = await fixture(t); const current = await f.roots.startup({ isolated: true }); await f.roots.persist(current)
  const before = await readFile(path.join(f.profile, WORKSPACE_SELECTION), 'utf8')
  f.roots.probe = async () => { throw Object.assign(new Error('Future schema'), { code: 'WORKSPACE_FUTURE_SCHEMA' }) }
  f.selected.push(f.first)
  await assert.rejects(f.roots.stage(), { code: 'WORKSPACE_FUTURE_SCHEMA' })
  assert.equal(f.roots.pending, undefined)
  assert.equal(await readFile(path.join(f.profile, WORKSPACE_SELECTION), 'utf8'), before)
})

test('selection preference symlinks and changed profile identity are never followed for writes', async t => {
  const f = await fixture(t); const current = await f.roots.startup({ isolated: true })
  const victim = path.join(f.base, 'victim'); await writeFile(victim, 'keep')
  await symlink(victim, path.join(f.profile, WORKSPACE_SELECTION))
  await assert.rejects(f.roots.persist(current)); assert.equal(await readFile(victim, 'utf8'), 'keep')
  await rm(path.join(f.profile, WORKSPACE_SELECTION))
  await rename(f.profile, `${f.profile}-old`); await mkdir(f.profile)
  await assert.rejects(f.roots.persist(current), { code: 'WORKSPACE_ROOT_STALE' })
})


test('read-only selected directory fails staging without granting a root or changing current selection', async t => {
  if (process.getuid?.() === 0) { t.skip('Filesystem permission negative control needs an unprivileged process'); return }
  const f = await fixture(t); const current = await f.roots.startup({ isolated: true }); await f.roots.persist(current)
  const before = await readFile(f.roots.selectionFile, 'utf8')
  await chmod(f.second, 0o500)
  try {
    f.selected.push(f.second)
    await assert.rejects(f.roots.stage(), { code: 'EACCES' })
    assert.equal(f.roots.pending, undefined)
    assert.equal(await readFile(f.roots.selectionFile, 'utf8'), before)
  } finally { await chmod(f.second, 0o700) }
})
