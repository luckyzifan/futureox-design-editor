import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cloudBaseUrl, createCloudCollaboration } from '../src/cloud-collaboration.mjs'

test('only HTTPS service paths and local test addresses can be configured', () => {
  assert.equal(cloudBaseUrl('https://futureox.com/desgin/'), 'https://futureox.com/desgin')
  assert.equal(cloudBaseUrl('http://127.0.0.1:54321/desgin'), 'http://127.0.0.1:54321/desgin')
  for (const value of ['http://futureox.com/desgin', 'https://x:y@futureox.com/', 'https://futureox.com/desgin?secret=1',
    'https://futureox.com/desgin%2fother', 'https://futureox.com//another']) {
    assert.throws(() => cloudBaseUrl(value))
  }
})

test('local is the default, IPC uses the configured path, and a committed local receipt restores its cloud cursor', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-cloud-host-'))
  const calls = [], token = 'v'.repeat(32), baseUrl = 'https://futureox.com/desgin', id = randomUUID()
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('opaque credential'),
    decryptString: () => token,
  }
  const create = (findLocalMutation = async () => null) => createCloudCollaboration({
    root: () => dir, safeStorage, documentLimit: 4096, platform: 'darwin', findLocalMutation,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, redirect: options.redirect })
      assert.equal(options.headers.Authorization, 'Bearer '+token)
      return Response.json([])
    },
  })
  try {
    const first = create()
    assert.equal((await first.status()).enabled, false)
    assert.deepEqual(calls, [])
    const active = await first.configure({ enabled: true, baseUrl, token })
    assert(active.handle)
    const settings = await readFile(path.join(dir, 'collaboration-v1/settings.json'), 'utf8')
    assert(!settings.includes(token))
    await assert.rejects(first.request({ handle: active.handle, callId: randomUUID(), method: 'GET', target: 'https://bad.test/' }))
    const mutationId = randomUUID()
    await first.writeCursor({ handle: active.handle, id, cursor: {
      revision: 3, pending: { requestId: randomUUID(), localRevision: 7 }, applying: { revision: 5, mutationId },
    } })
    const restarted = create(async (documentId, mutation) => {
      assert.equal(documentId, id); assert.equal(mutation, mutationId); return 8
    })
    const resumed = await restarted.status()
    assert(resumed.enabled && resumed.handle)
    assert.deepEqual((await restarted.readCursor({ handle: resumed.handle, id })).cursor, { revision: 5 })
    await restarted.request({ handle: resumed.handle, callId: randomUUID(), method: 'GET', target: '/documents/' + id + '/versions/5' })
    assert.deepEqual(calls, [
      { url: baseUrl+'/api/design/documents', method: 'GET', redirect: 'error' },
      { url: baseUrl+'/api/design/documents/'+id+'/versions/5', method: 'GET', redirect: 'error' },
    ])
    await restarted.configure({ enabled: false })
    await assert.rejects(restarted.request({ handle: resumed.handle, callId: randomUUID(), method: 'GET', target: '/documents' }))
    assert.equal((await create().status()).enabled, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
