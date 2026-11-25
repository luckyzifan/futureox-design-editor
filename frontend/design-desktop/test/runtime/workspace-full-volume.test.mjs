import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, open, readFile, realpath, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceRoots, WORKSPACE_SELECTION } from '../../src/workspace-roots.mjs'
import { Sidecar } from '../../src/sidecar.mjs'

const exec = promisify(execFile)
const backend = process.env.CORE_DESKTOP_SIDECAR
const hdi = (...args) => exec('/usr/bin/hdiutil', args, { timeout: 30_000 })
const availableBytes = async mount => {
  const fs = await statfs(mount)
  return fs.bavail * fs.bsize
}

async function fillVolume(mount) {
  assert.notEqual((await stat(mount)).dev, (await stat(path.dirname(mount))).dev)
  const filler = await open(path.join(mount, 'test-filler'), 'a', 0o600)
  const bytes = randomBytes(1024 * 1024)
  try {
    for (const grain of [bytes.length, 65536, 4096, 512]) {
      let full = false
      for (let attempt = 0; attempt < 96; attempt++) {
        try { assert.ok((await filler.write(bytes, 0, grain)).bytesWritten) }
        catch (error) {
          if (error.code !== 'ENOSPC') throw error
          full = true
          break
        }
      }
      assert.ok(full, 'the owned test volume must reach ENOSPC')
    }
    assert.equal(await availableBytes(mount), 0)
  } finally { await filler.close() }
}

async function fullVolumeFixture(t) {
    assert.ok(backend && path.isAbsolute(backend), 'provide the current CORE_DESKTOP_SIDECAR')
    const scope = await realpath(await mkdtemp(path.join(tmpdir(), 'futureox-full-volume-')))
    const mount = path.join(scope, 'mount'), profile = path.join(scope, 'profile')
    const image = path.join(scope, 'owned-volume.dmg')
    let device
    const children = new Set()
    t.after(async () => {
      for (const child of children) await child.stop()
      const mounted = await stat(mount).catch(() => null)
      if (device) await hdi('detach', device)
      else if (mounted && mounted.dev !== (await stat(scope)).dev) await hdi('detach', mount)
      await rm(scope, { recursive: true, force: true })
    })
    await Promise.all([mkdir(mount), mkdir(profile)])
    await hdi('create', '-size', '80m', '-fs', 'HFS+', '-volname', 'FutureoxFullVolume', image)
    const { stdout } = await hdi('attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', image)
    const attachment = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: stdout, encoding: 'utf8' }))
    const volume = attachment['system-entities'].find(entry => entry['mount-point'] === mount)
    assert.match(volume?.['dev-entry'] || '', /^\/dev\/disk\d+(?:s\d+)*$/)
    device = volume['dev-entry']
    assert.notEqual((await stat(mount)).dev, (await stat(scope)).dev)

    function start(config) {
      let process
      const child = new Sidecar(backend, config.recoveryDir, {
        ...config, timeoutMs: 15_000,
        spawnProcess(...args) { process = spawn(...args); return process },
      })
      children.add(child)
      return { child, process }
    }
    async function stop(child) {
      assert.equal(await child.stop(), true)
      children.delete(child)
    }

    return { scope, mount, profile, start, stop }
}

const volumeTestOptions = { skip: process.platform !== 'darwin', timeout: 120_000 }

for (const exitKind of ['clean', 'abrupt']) {
  test(`a saved workspace reopens the last committed revision after a ${exitKind} exit on a truly full volume`,
    volumeTestOptions, async t => {
    const { scope, mount, profile, start, stop } = await fullVolumeFixture(t)
    const doc = { schemaVersion: 6, id: randomUUID(), name: 'Original committed design',
      pages: [{ id: randomUUID(), name: 'Page', children: [], background: '#ffffff' }], nodes: {} }
    const original = path.join(scope, 'original.json')
    const originalBytes = JSON.stringify(doc)
    await writeFile(original, originalBytes, { mode: 0o400 })
    const commit = (child, document, expectedRevision) =>
      child.request('workspace.commit', { document, expectedRevision, mutationId: randomUUID() })
    const dialog = { async showMessageBox() { throw new Error('The saved workspace fell back to the picker') } }
    const initial = new WorkspaceRoots({ profileRoot: profile, dialog })
    await initial.initialize()
    const root = await initial.prepare(mount)
    await initial.persist(root)
    const selectionPath = path.join(profile, WORKSPACE_SELECTION)
    const selection = await readFile(selectionPath)
    const config = initial.config(root)
    const seeded = start(config)
    const first = await commit(seeded.child, doc, null)
    assert.equal(first.revision, 1)
    const saved = { ...doc, name: 'Last committed revision before abrupt exit' }
    const second = await commit(seeded.child, saved, first.revision)
    assert.equal(second.revision, 2)
    if (exitKind === 'abrupt') {
      assert.ok((await stat(config.workspaceDb + '-wal')).size > 0)
      const exited = once(seeded.process, 'exit')
      seeded.process.kill('SIGKILL')
      assert.deepEqual(await exited, [null, 'SIGKILL'])
    }
    await stop(seeded.child)
    const wal = await stat(config.workspaceDb + '-wal').catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    assert.equal(exitKind === 'abrupt', !!wal?.size)

    await fillVolume(mount)
    const reserveName = '.' + path.basename(config.workspaceDb) + '.reopen-space-v1'
    const reopened = new WorkspaceRoots({ profileRoot: profile, dialog, async probe(next) {
      const { child } = start(next)
      try {
        const health = await child.request('health')
        assert.equal(health.workspaceAvailable, true, JSON.stringify(health.workspaceError))
        assert.equal(health.catalogAvailable, true, JSON.stringify(health.catalogError))
        assert.equal((await child.request('workspace.list')).documents.length, 1)
        await child.request('catalog.list')
        const opened = await child.request('workspace.open', { id: doc.id })
        assert.equal(opened.revision, second.revision)
        assert.equal(opened.hash, second.hash)
        assert.equal(opened.document.name, saved.name)
        if (exitKind === 'clean') assert.ok(!(await readdir(root.storagePath)).includes(reserveName))
        // Exhaust the bytes that SQLite did not need for recovery. A content
        // write must fail atomically while reads still see the saved revision.
        await fillVolume(mount)
        const rejected = { ...doc, name: 'Rejected edit while full', pages: Array.from({ length: 8 }, () => ({
          ...doc.pages[0], id: randomUUID(), name: randomBytes(4096).toString('hex'),
        })) }
        await assert.rejects(commit(child, rejected, second.revision), error => error.code === 'WORKSPACE_STORAGE_FULL')
        assert.equal((await child.request('workspace.open', { id: doc.id })).hash, second.hash)
      } finally { await stop(child) }
    } })
    assert.equal((await reopened.startup()).storagePath, root.storagePath)
    assert.deepEqual(await readFile(selectionPath), selection)
    await rm(path.join(mount, 'test-filler'))

    const { child } = start(config)
    try {
      assert.equal((await child.request('workspace.open', { id: doc.id })).hash, second.hash)
      assert.equal((await commit(child, { ...doc, name: 'After freeing space' }, second.revision)).revision, 3)
    } finally { await stop(child) }
    assert.equal(await readFile(original, 'utf8'), originalBytes)
    console.log(`WORKSPACE_FULL_VOLUME exit=${exitKind} readRevision=2 retainedHash=true writeFailed=WORKSPACE_STORAGE_FULL nextRevision=3`)
  })
}

test('a large source reopens its edited checkpoint when the working volume cannot write an index',
  volumeTestOptions, async t => {
  const { scope, mount, start, stop } = await fullVolumeFixture(t)
  const source = path.join(scope, 'source.json')
  const config = { recoveryDir: path.join(mount, 'recovery'), catalogDb: path.join(scope, 'catalog.sqlite3') }
  const sourceBytes = JSON.stringify({ name: 'Original source', fields: Array.from({ length: 4000 }, (_, n) => n) })
  await writeFile(source, sourceBytes, { mode: 0o400 })
  const openSource = (child, sessionEpoch) =>
    child.request('large.open', { path: source, documentId: randomUUID(), sessionEpoch })
  const readRoot = (child, open) =>
    child.request('large.read', { owner: open.owner, expectedRevision: open.revision, key: '0:0' })
  const changeName = (child, open, before, name) =>
    child.request('large.apply', { owner: open.owner, expectedRevision: open.revision, key: '0:0',
      json: JSON.stringify({ ...JSON.parse(before.json), name }), expectedHash: before.hash, requestId: randomUUID() })

  const original = start(config).child
  const opened = await openSource(original, 1)
  const first = await readRoot(original, opened)
  const edited = await changeName(original, opened, first, 'Saved working copy')
  assert.equal(edited.revision, 1)
  await stop(original)

  await fillVolume(mount)
  const temporaryIndexes = async () => (await readdir(tmpdir())).filter(name => name.startsWith('futureox-source-index-')).sort()
  const previous = await temporaryIndexes()
  const restored = start(config).child
  const recovered = await openSource(restored, 2)
  assert.equal(recovered.revision, 1)
  const before = await readRoot(restored, recovered)
  assert.equal(JSON.parse(before.json).name, 'Saved working copy')
  assert.equal((await temporaryIndexes()).length, previous.length + 1)
  assert.equal(await availableBytes(mount), 0)
  await assert.rejects(changeName(restored, recovered, before, 'Uncommitted while full'), error => error.code === 'SOURCE_STORAGE_FULL')
  assert.equal((await readRoot(restored, recovered)).hash, before.hash)

  await rm(path.join(mount, 'test-filler'))
  const committed = await changeName(restored, recovered, before, 'Saved after freeing space')
  assert.equal(committed.revision, 2)
  await restored.request('large.close', { owner: recovered.owner, expectedRevision: 2 })
  assert.deepEqual(await temporaryIndexes(), previous)
  await stop(restored)

  const after = start(config).child
  const reopened = await openSource(after, 3)
  assert.equal(reopened.revision, 2)
  assert.equal(JSON.parse((await readRoot(after, reopened)).json).name, 'Saved after freeing space')
  await stop(after)
  assert.equal(await readFile(source, 'utf8'), sourceBytes)
  console.log('SOURCE_FULL_VOLUME readRevision=1 writeFailed=SOURCE_STORAGE_FULL nextRevision=2 temporaryIndexRemoved=true')
})
