import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDesignAgentHost } from '../src/design-agent-host.mjs'

const bin = new URL('../../../design-studio/target/debug/futureox-design-agent', import.meta.url).pathname

test('desktop host stores an API and a token plan, switches them, and reads CC Switch without echoing secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-agent-'))
  const db = path.join(dir, 'cc-switch.db')
  const { spawnSync } = await import('node:child_process')
  const created = spawnSync('sqlite3', [db, `CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type));
INSERT INTO providers VALUES ('codex-plan','codex','Codex plan','{"api_key":"do-not-leak"}',1);
CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, listen_address TEXT, listen_port INTEGER, enabled INTEGER, proxy_enabled INTEGER);
INSERT INTO proxy_config VALUES ('codex','127.0.0.1',15721,1,1);`])
  assert.equal(created.status, 0, created.stderr?.toString())
  const host = createDesignAgentHost({
    bin, port: 39284, storePath: path.join(dir, 'providers.json'),
    env: { ...process.env, CCSWITCH_DB: db },
  })
  try {
    const api = await host.upsert({ id: 'shop-api', name: 'Shop API', kind: 'api', base_url: 'https://api.example.test/v1', model: 'shop', secret: 'api-secret-value', wire: 'openai_chat' })
    assert.equal(api.status, 'ok')
    const plan = await host.upsert({ id: 'shop-plan', name: 'Shop plan', kind: 'token_plan', base_url: 'https://plan.example.test/v1', model: 'plan-model', secret: 'plan-secret-value', wire: 'openai_chat' })
    assert.equal(plan.status, 'ok')
    assert.equal((await host.activate({ id: 'shop-plan' })).status, 'ok')
    const status = await host.status()
    assert.equal(status.status, 'ok')
    const encoded = JSON.stringify(status)
    assert.equal(encoded.includes('api-secret-value'), false)
    assert.equal(encoded.includes('plan-secret-value'), false)
    assert.equal(encoded.includes('do-not-leak'), false)
    assert.equal(status.providers.some(item => item.id === 'shop-plan' && item.active && item.kind === 'token_plan' && item.has_secret), true)
    assert.equal(status.ccswitch.present, true)
    assert.equal(status.ccswitch.providers.some(item => item.name === 'Codex plan' && item.current && item.has_secret), true)
    assert.equal((await host.activate({ id: 'ccswitch', profile_id: 'codex:codex-plan' })).status, 'ok')
    const switched = await host.status()
    assert.equal(switched.providers.some(item => item.id === 'ccswitch' && item.active), true)
    assert.equal(JSON.stringify(switched).includes('do-not-leak'), false)
    const saved = await readFile(path.join(dir, 'providers.json'), 'utf8')
    assert.match(saved, /plan-secret-value/)
    const again = createDesignAgentHost({ bin, port: 39285, storePath: path.join(dir, 'providers.json'), env: process.env })
    try {
      const restored = await again.status()
      assert.equal(restored.providers.some(item => item.id === 'shop-plan' && item.has_secret), true)
    } finally { again.dispose() }
  } finally {
    host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

function savedProvider(id, kind = 'api') {
  return {
    id, name: id, kind,
    base_url: 'http://127.0.0.1:9/v1',
    model: `${id}-model`,
    secret: `synthetic-${id}-key`,
    wire: 'openai_chat',
  }
}

function activeId(status) {
  assert.equal(status.status, 'ok')
  const active = status.providers.filter(item => item.active)
  assert.equal(active.length, 1)
  return active[0].id
}

test('remove persists the kernel active connection and a second host does not restore the deleted one', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-agent-remove-'))
  const file = path.join(dir, 'providers.json')
  const host = createDesignAgentHost({ bin, port: 39311, storePath: file, env: process.env })
  try {
    assert.equal((await host.upsert(savedProvider('qa-a'))).status, 'ok')
    assert.equal((await host.upsert(savedProvider('qa-b', 'token_plan'))).status, 'ok')
    assert.equal((await host.upsert(savedProvider('qa-deleted', 'token_plan'))).status, 'ok')
    assert.equal((await host.activate({ id: 'qa-deleted' })).status, 'ok')
    assert.equal(activeId(await host.status()), 'qa-deleted')
    const removedOther = await host.remove({ id: 'qa-a' })
    assert.equal(removedOther.status, 'ok')
    let saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.active, 'qa-deleted')
    assert.deepEqual(saved.providers.map(item => item.id).sort(), ['qa-b', 'qa-deleted'])
    assert.equal(saved.providers.some(item => String(item.secret).includes('synthetic-qa-a-key')), false)
    assert.equal(saved.providers.some(item => item.secret === 'synthetic-qa-b-key'), true)
    assert.equal(activeId(await host.status()), 'qa-deleted')
    const removedActive = await host.remove({ id: 'qa-deleted' })
    assert.equal(removedActive.status, 'ok')
    saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.active, 'local')
    assert.deepEqual(saved.providers.map(item => item.id), ['qa-b'])
    assert.equal(JSON.stringify(saved).includes('synthetic-qa-deleted-key'), false)
    assert.equal(saved.providers[0].secret, 'synthetic-qa-b-key')
    const after = await host.status()
    assert.equal(activeId(after), 'local')
    assert.equal(after.providers.some(item => item.id === 'qa-deleted' || item.id === 'qa-a'), false)
    assert.equal(after.providers.some(item => item.id === 'qa-b' && item.kind === 'token_plan' && item.has_secret && !item.active), true)
    assert.equal(JSON.stringify(after).includes('synthetic-'), false)
    const againBytes = await readFile(file)
    const duplicate = await host.remove({ id: 'qa-deleted' })
    assert.equal(duplicate.status, 'error')
    assert.equal(JSON.stringify(duplicate).includes('synthetic-'), false)
    assert.deepEqual(await readFile(file), againBytes)
    assert.equal(activeId(await host.status()), 'local')
    const local = await host.remove({ id: 'local' })
    assert.equal(local.status, 'error')
    assert.match(local.message, /local/)
    assert.deepEqual(await readFile(file), againBytes)
    assert.equal(activeId(await host.status()), 'local')
  } finally { host.dispose() }
  const restoredHost = createDesignAgentHost({ bin, port: 39312, storePath: file, env: process.env })
  try {
    const restored = await restoredHost.status()
    assert.equal(activeId(restored), 'local')
    assert.equal(restored.providers.some(item => item.id === 'qa-deleted' || item.id === 'qa-a'), false)
    assert.equal(restored.providers.some(item => item.id === 'qa-b' && item.has_secret && !item.active), true)
    assert.equal(JSON.stringify(restored).includes('synthetic-'), false)
  } finally {
    restoredHost.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed provider store write does not report success or drop the saved connection', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-agent-store-fail-'))
  const file = path.join(dir, 'providers.json')
  const host = createDesignAgentHost({ bin, port: 39321, storePath: file, env: process.env })
  try {
    assert.equal((await host.upsert(savedProvider('qa-keep'))).status, 'ok')
    assert.equal((await host.activate({ id: 'qa-keep' })).status, 'ok')
    const before = await readFile(file)
    await chmod(dir, 0o555)
    try {
      const failed = await host.remove({ id: 'qa-keep' })
      assert.equal(failed.status, 'error')
      assert.match(failed.message, /没有删除/)
      assert.match(failed.message, /写入失败/)
      assert.match(failed.message, /原连接仍在/)
      assert.equal(JSON.stringify(failed).includes('synthetic-qa-keep-key'), false)
      assert.deepEqual(await readFile(file), before)
      const status = await host.status()
      assert.equal(activeId(status), 'qa-keep')
      assert.equal(status.providers.some(item => item.id === 'qa-keep' && item.has_secret), true)
      assert.equal(JSON.stringify(status).includes('synthetic-qa-keep-key'), false)
    } finally { await chmod(dir, 0o755) }
  } finally { host.dispose() }
  const restoredHost = createDesignAgentHost({ bin, port: 39322, storePath: file, env: process.env })
  try {
    const restored = await restoredHost.status()
    assert.equal(activeId(restored), 'qa-keep')
    assert.equal(restored.providers.some(item => item.id === 'qa-keep' && item.has_secret), true)
    assert.equal(JSON.stringify(restored).includes('synthetic-qa-keep-key'), false)
    await writeFile(file, '{')
    const corrupt = await restoredHost.remove({ id: 'qa-keep' })
    assert.equal(corrupt.status, 'error')
    assert.match(corrupt.message, /已损坏/)
    assert.equal(corrupt.message.includes('已删除'), false)
    assert.equal(await readFile(file, 'utf8'), '{')
    const still = await restoredHost.status()
    assert.equal(activeId(still), 'qa-keep')
    assert.equal(still.providers.some(item => item.id === 'qa-keep' && item.has_secret), true)
    assert.deepEqual(await readFile(file), Buffer.from('{'))
  } finally {
    restoredHost.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('activating a saved connection sends the next turn to that provider and keeps the session', { timeout: 60_000 }, async () => {
  const seen = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push({ authorization: request.headers.authorization, model: body.model, users: (body.messages || []).filter(item => item.role === 'user').map(item => item.content) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已看到这一页。', tool_calls: [] } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const base = `http://127.0.0.1:${address.port}/v1`
  const dir = await mkdtemp(path.join(tmpdir(), 'design-agent-switch-'))
  const file = path.join(dir, 'providers.json')
  const host = createDesignAgentHost({ bin, port: 39341, storePath: file, env: process.env })
  const context = { current_page_id: 'page-1', pages: [{ id: 'page-1', name: '原稿' }], nodes: [], selection: [] }
  const documentName = 'qa-document-must-stay'
  try {
    const api = savedProvider('qa-a')
    api.base_url = base
    const plan = savedProvider('qa-b', 'token_plan')
    plan.base_url = base
    assert.equal((await host.upsert(api)).status, 'ok')
    assert.equal((await host.upsert(plan)).status, 'ok')
    assert.equal((await host.activate({ id: 'qa-a' })).status, 'ok')
    const first = await host.turn({ session_id: 'sess-switch', message: '先看原稿的标题', context })
    assert.equal(first.status, 'ok')
    assert.equal(first.turn.sessionId, 'sess-switch')
    assert.equal(first.turn.assistant, 'api')
    assert.deepEqual(first.turn.operations, [])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].authorization, 'Bearer synthetic-qa-a-key')
    assert.equal(seen[0].model, 'qa-a-model')
    assert.equal((await host.activate({ id: 'qa-b' })).status, 'ok')
    const second = await host.turn({ session_id: 'sess-switch', message: '再看副标题', context })
    assert.equal(second.status, 'ok')
    assert.equal(second.turn.assistant, 'token-plan')
    assert.deepEqual(second.turn.operations, [])
    assert.equal(seen.length, 2)
    assert.equal(seen[1].authorization, 'Bearer synthetic-qa-b-key')
    assert.equal(seen[1].model, 'qa-b-model')
    assert.equal(seen[1].users.includes('先看原稿的标题'), true)
    assert.equal((await host.remove({ id: 'qa-a' })).status, 'ok')
    const third = await host.turn({ session_id: 'sess-switch', message: '标题还在吗', context })
    assert.equal(third.status, 'ok')
    assert.equal(third.turn.assistant, 'token-plan')
    assert.deepEqual(third.turn.operations, [])
    assert.equal(seen.length, 3)
    assert.equal(seen[2].authorization, 'Bearer synthetic-qa-b-key')
    assert.equal(seen[2].users.includes('先看原稿的标题'), true)
    assert.equal(seen[2].users.includes('再看副标题'), true)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.active, 'qa-b')
    assert.equal(saved.providers.some(item => item.id === 'qa-a'), false)
    assert.equal(JSON.stringify(saved).includes('synthetic-qa-a-key'), false)
    assert.equal(saved.providers.some(item => item.id === 'qa-b' && item.secret === 'synthetic-qa-b-key'), true)
    const status = await host.status()
    assert.equal(activeId(status), 'qa-b')
    assert.equal(JSON.stringify(status).includes('synthetic-'), false)
    assert.equal(JSON.stringify([first, second, third, seen]).includes(documentName), false)
  } finally {
    host.dispose()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
