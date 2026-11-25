import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPluginDirectoryHost } from '../src/plugin-package.mjs'
import { createPluginStorageHost } from '../src/plugin-storage-host.mjs'
import { Sidecar } from '../src/sidecar.mjs'

const binary = process.env.FUTUREOX_BACKEND_TEST_BINARY
const key = name => Buffer.from(name, 'utf16le').swap16().toString('hex')

test('storage scopes come from canonical folder grants and opaque leases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-scope-'))
  try {
    const directories = createPluginDirectoryHost()
    const manifest = JSON.stringify({ id: 'same.id', name: 'Test', api: '1.0.0', main: 'code.js' })
    for (const name of ['first', 'second']) {
      await mkdir(path.join(root, name))
      await writeFile(path.join(root, name, 'manifest.json'), manifest)
    }
    const seen = []
    let releaseRequest
    const host = createPluginStorageHost({
      folderScope: grant => directories.storageScope(grant),
      async request(_method, params, _bytes, assertCurrent) {
        seen.push(params.scope)
        await new Promise(resolve => { releaseRequest = resolve })
        assertCurrent()
        return []
      },
    })
    const first = await directories.take(path.join(root, 'first'))
    const older = host.begin({ folderGrant: first.grant })
    const inFlight = host.call(older, { kind: 'keys' })
    const second = await directories.take(path.join(root, 'second'))
    const active = host.begin({ folderGrant: second.grant })
    releaseRequest()
    await assert.rejects(inFlight, error => error.code === 'PLUGIN_STORAGE_SESSION')
    await assert.rejects(() => host.call(older, { kind: 'keys' }))
    assert.throws(() => host.begin({ folderGrant: first.grant }), error => error.code === 'PLUGIN_GRANT')
    const request = host.call(active, { kind: 'keys' })
    releaseRequest()
    assert.deepEqual(await request, [])
    assert.match(seen[0], /^[a-f0-9]{64}$/)
    assert.notEqual(seen[0], seen[1])
    const again = await directories.take(path.join(root, 'first'))
    assert.equal(directories.storageScope(again.grant), seen[0])
    assert.throws(() => host.begin({ folderGrant: again.grant, archiveDigest: seen[0] }))
    host.end(active)
    await assert.rejects(() => host.call(active, { kind: 'keys' }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('plugin preferences persist across native processes and keep quotas atomic', { skip: !binary }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-sqlite-'))
  const db = path.join(root, 'plugin-storage.sqlite3')
  const scope = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const backends = []
  const start = index => {
    const backend = new Sidecar(binary, path.join(root, 'recovery-' + index), {
      catalogDb: path.join(root, 'catalog-' + index + '.sqlite3'), pluginStorageDb: db,
    })
    backends.push(backend)
    return backend
  }
  const read = (backend, operation, owner = scope) => backend.request('plugin.storage.read', { scope: owner, operation })
  const write = (backend, operation, owner = scope) => backend.request('plugin.storage.write', { scope: owner, operation })
  try {
    const first = start(1)
    const second = start(2)
    await Promise.all([first.request('health'), second.request('health')])
    const json = { kind: 'json', json: '{"answer":7,"escaped":"\\ud83d"}' }
    const bytes = { kind: 'bytes', rawBytes: 6, parts: ['AAEC', 'AwQF'] }
    const note = key('note')
    const image = key('图😀')
    await Promise.all([
      write(first, { kind: 'set', key: note, value: json }),
      write(second, { kind: 'set', key: image, value: bytes }),
    ])
    assert.deepEqual(await read(first, { kind: 'get', key: note }, other), null)
    await assert.rejects(
      write(first, { kind: 'set', key: note, value: { kind: 'json', json: '"' + 'x'.repeat(5 * 1024 * 1024) + '"' } }),
      error => error.code === 'PLUGIN_STORAGE_LIMIT',
    )
    assert.deepEqual(await read(second, { kind: 'get', key: note }), json)
    await assert.rejects(
      write(first, { kind: 'set', key: note, value: { kind: 'bytes', rawBytes: 1, parts: ['AQI='] } }),
      error => error.code === 'PLUGIN_STORAGE_INVALID',
    )
    await write(first, { kind: 'set', key: key('undefined'), value: { kind: 'undefined' } })
    await Promise.all([first.stop(), second.stop()])
    assert.equal((await readFile(db)).subarray(0, 16).toString(), 'SQLite format 3\0')
    const restarted = start(3)
    assert.deepEqual(await read(restarted, { kind: 'get', key: image }), bytes)
    assert.deepEqual(await read(restarted, { kind: 'get', key: note }), json)
    assert.deepEqual(await read(restarted, { kind: 'get', key: key('undefined') }), { kind: 'undefined' })
    assert.deepEqual(new Set(await read(restarted, { kind: 'keys' })), new Set([note, image, key('undefined')]))
    await write(restarted, { kind: 'delete', key: image })
    assert.deepEqual(await read(restarted, { kind: 'get', key: image }), null)
  } finally {
    await Promise.all(backends.map(backend => backend.stop()))
    await rm(root, { recursive: true, force: true })
  }
})
