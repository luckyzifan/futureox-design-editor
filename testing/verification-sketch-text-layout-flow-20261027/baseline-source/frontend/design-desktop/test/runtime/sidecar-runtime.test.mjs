import { DOCUMENT_BYTE_LIMIT, DOCUMENT_MEMORY_BYTES } from '../../src/document-capacity.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import os from 'node:os'
const { Sidecar } = await import(new URL('sidecar.mjs', process.env.CORE_DESKTOP_TEST_SOURCE).href)

const binary = process.env.CORE_DESKTOP_SIDECAR
if (!binary || !path.isAbsolute(binary))
  throw new Error('CORE_DESKTOP_SIDECAR must name the actual built Rust executable')
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forma-package-runtime-')))
const recovery = path.join(root, 'recovery')
await mkdir(recovery, { mode: 0o700 })
const target = path.join(root, '本地测试.fd')
const fixture = {
  schemaVersion: 6,
  id: randomUUID(),
  name: '本地持久化 🧪',
  pages: [{ id: randomUUID(), name: '页面 1', children: [], background: '#ffffff' }],
  nodes: {},
  customMetadata: { preserved: 'unknown author fields survive round-trip' },
}
let sidecar
let savedHash
function launch() {
  const backend = new Sidecar(binary, recovery, { timeoutMs: 5000, catalogDb: path.join(root, 'catalog.sqlite3') })
  backend.on('unavailable', () => {})
  return backend
}

try {
  await test('actual JavaScript sidecar bridge completes health, save, and Unicode document open', async () => {
    sidecar = launch()
    const health = await sidecar.request('health')
    assert.equal(health.protocolVersion, 1)
    assert.equal(health.maxDocumentBytes, DOCUMENT_BYTE_LIMIT)
    assert.equal(health.documentCapacity.memoryBytes, DOCUMENT_MEMORY_BYTES)
    assert.equal(health.documentTransferVersion, 1)
    const fresh = await sidecar.request('stat', { path: target })
    assert.equal(fresh.hash, null)
    const saved = await sidecar.request('save', {
      path: target,
      document: fixture,
      expectedHash: null,
    })
    assert.match(saved.hash, /^[0-9a-f]{64}$/)
    savedHash = saved.hash
    const bytes=await readFile(target)
    assert.equal(bytes.subarray(0,4).toString(),'FXDK')
    assert.equal(bytes.readUInt16LE(4),2)
    const opened = await sidecar.request('open', { path: target })
    assert.equal(opened.hash, saved.hash)
    assert.deepEqual(opened.document, fixture)
  })

  await test('external modification is detected and never overwritten by stale save baseline', async () => {
    const external = { ...fixture, name: 'External modification retained' }
    await writeFile(target, JSON.stringify(external))
    await assert.rejects(
      sidecar.request('save', {
        path: target,
        expectedHash: savedHash,
        document: { ...fixture, name: 'Must not overwrite' },
      }),
      (error) => error.code === 'CONFLICT',
    )
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), external)
    const current = await sidecar.request('stat', { path: target })
    await assert.rejects(
      sidecar.request('save', {
        path: target,
        expectedHash: current.hash,
        document: { invalid: true },
      }),
      (error) => error.code === 'INVALID_DOCUMENT',
    )
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), external)
  })

  await test('recovery survives real backend process restart and preserves the authored JSON', async () => {
    const recoveryId = `runtime-${randomUUID()}`
    const created = await sidecar.request('recovery.write', {
      recoveryId,
      document: fixture,
      sourcePath: null,
      sourceHash: null,
    })
    assert.equal(created.recoveryId, recoveryId)
    const oldPid = sidecar.child.pid
    assert.equal(await sidecar.stop(), true, 'First backend must be reaped')
    assert.throws(
      () => process.kill(oldPid, 0),
      (error) => error.code === 'ESRCH',
    )
    sidecar = launch()
    const list = await sidecar.request('recovery.list')
    assert.equal(list.entries.length, 1)
    assert.equal(list.entries[0].recoveryId, recoveryId)
    assert.deepEqual(list.issues, [])
    const restored = await sidecar.request('recovery.read', { recoveryId })
    assert.deepEqual(restored.document, fixture)
    assert.equal(restored.hash, created.hash)
    assert.equal((await sidecar.request('recovery.remove', { recoveryId })).removed, true)
    assert.equal((await sidecar.request('recovery.list')).entries.length, 0)
  })

  await test('actual catalog persists metadata but restart requires renewed directory authority', async () => {
    const registered = await sidecar.request('catalog.register', { path: root, name: 'Owned runtime catalog' })
    const directoryId = registered.directory.id
    const scanned = await sidecar.request('catalog.scan', { directoryId, path: root })
    assert.equal(scanned.truncated, false)
    assert.ok(scanned.files.some((file) => file.relativePath === path.basename(target)))
    const fileId = scanned.files.find((file) => file.relativePath === path.basename(target)).id
    assert.equal((await sidecar.request('open', { path: target, directoryId })).document.name, 'External modification retained')
    assert.equal(await sidecar.stop(), true)
    sidecar = launch()
    const listed = await sidecar.request('catalog.list')
    assert.equal(listed.requiresReselection, true)
    assert.ok(listed.directories.some((directory) => directory.id === directoryId))
    assert.ok(listed.files.some((file) => file.id === fileId))
    await assert.rejects(sidecar.request('catalog.scan', { directoryId, path: root }))
    const renewed = await sidecar.request('catalog.register', { path: root })
    assert.equal(renewed.directory.id, directoryId)
    assert.ok((await sidecar.request('catalog.scan', { directoryId, path: root })).files.length >= 1)
  })

  await test('unknown method is rejected without losing backend health; shutdown reaps owned process', async () => {
    await assert.rejects(
      sidecar.request('exec', { command: 'not executed' }),
      (error) => error.code === 'UNKNOWN_METHOD',
    )
    assert.equal((await sidecar.request('health')).protocolVersion, 1)
    const pid = sidecar.child.pid
    assert.equal(await sidecar.stop(), true)
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    )
    assert.equal(sidecar.pending.size, 0)
  })
} finally {
  if (sidecar) await sidecar.stop()
  await rm(root, { recursive: true, force: true })
}
