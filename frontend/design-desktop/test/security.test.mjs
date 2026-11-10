import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  APP_URL,
  CSP,
  MAX_DOCUMENT_BYTES,
  assertSender,
  documentFromString,
  isAppResource,
  record,
  resourcePath,
  resultError,
  validHandle,
} from '../src/security.mjs'

test('protocol origin is parsed exactly, never prefix matched', () => {
  assert.equal(isAppResource(APP_URL), true)
  for (const url of [
    'https://app/index.html',
    'file:///etc/passwd',
    'design-app://app.evil/a',
    'design-app://user@app/a',
    'design-app://app:80/a',
    'not a url',
  ])
    assert.equal(isAppResource(url), false)
})
test('only the exact live window top frame and document can invoke IPC', () => {
  const frame = { url: APP_URL }
  const contents = { mainFrame: frame }
  const window = { isDestroyed: () => false, webContents: contents }
  assertSender({ sender: contents, senderFrame: frame }, window)
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url: APP_URL } },
    { sender: contents, senderFrame: null },
  ])
    assert.throws(() => assertSender(event, window))
  frame.url = `${APP_URL}#untrusted`
  assert.throws(() => assertSender({ sender: contents, senderFrame: frame }, window))
  frame.url = APP_URL
  assert.throws(() =>
    assertSender({ sender: contents, senderFrame: frame }, { ...window, isDestroyed: () => true }),
  )
})
test('resource resolution rejects encoded traversal and symlink escapes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forma-protocol-')))
  try {
    await mkdir(path.join(root, 'renderer'))
    await writeFile(path.join(root, 'renderer/index.html'), '<html></html>')
    await writeFile(path.join(root, 'private.txt'), 'private')
    await symlink(path.join(root, 'private.txt'), path.join(root, 'renderer/escape.js'))
    assert.equal(
      await resourcePath(path.join(root, 'renderer'), APP_URL),
      path.join(root, 'renderer/index.html'),
    )
    await assert.rejects(
      resourcePath(path.join(root, 'renderer'), 'design-app://app/%2e%2e%2fprivate.txt'),
    )
    await assert.rejects(resourcePath(path.join(root, 'renderer'), 'design-app://app/escape.js'))
    await assert.rejects(
      resourcePath(path.join(root, 'renderer'), 'design-app://app/..%5cprivate.txt'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('payload contracts reject arbitrary paths and bound UTF-8 document size', () => {
  assert.throws(() => record({ path: '/tmp/private' }, ['handle']))
  assert.throws(() => record([], ['handle']))
  assert.throws(() => documentFromString('[]'))
  assert.throws(() => documentFromString('null'))
  assert.throws(() =>
    documentFromString(`{"a":"${'字'.repeat(Math.ceil(MAX_DOCUMENT_BYTES / 3))}"}`),
  )
  assert.deepEqual(documentFromString('{"schema":6}'), { schema: 6 })
  assert.equal(validHandle('/etc/passwd'), false)
  assert.equal(validHandle('ba2640cb-5b49-45e5-a957-77327f7e1e46'), true)
})
test('CSP denies remote code, frames, objects, forms and only permits WASM compile', () => {
  assert.match(CSP, /default-src 'none'/)
  assert.match(CSP, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.doesNotMatch(CSP, /script-src[^;]*'unsafe-eval'/)
  assert.doesNotMatch(CSP, /script-src[^;]*'unsafe-inline'/)
  for (const kind of ['frame-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors'])
    assert.ok(CSP.includes(`${kind} 'none'`))
  assert.match(CSP, /connect-src 'self'/)
})
test('backend errors preserve conflict status without leaking local paths', () => {
  assert.equal(resultError({ code: 'CONFLICT' }).status, 'conflict')
  assert.equal(
    resultError({ code: 'IO', message: '/home/user/private/example.fd' }).message.includes(
      '/home',
    ),
    false,
  )
  const full = resultError({ code: 'WORKSPACE_STORAGE_FULL', message: '/private/workspace.sqlite3' })
  const migration = resultError({ code: 'WORKSPACE_MIGRATION', message: '/private/workspace.sqlite3' })
  const source = resultError({ code: 'SOURCE_WRITE_FAILED', message: '/private/original.sketch' })
  assert.equal(full.status, 'error')
  assert.notEqual(full.message, migration.message)
  assert.notEqual(full.message, source.message)
  for (const item of [full, migration, source]) {
    assert.equal(item.message.includes('/private'), false)
    assert.equal(item.message.includes('saved'), false)
    assert.equal(item.message.includes('没有写入') || item.message.includes('未改动'), true)
  }
})
