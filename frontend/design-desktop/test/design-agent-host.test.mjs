import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDesignAgentHost, resolveDesignAgentBinary } from '../src/design-agent-host.mjs'

function builtAgent() {
  const names = [
    process.env.DESIGN_AGENT_BIN,
    filePath('../dist/bin/futureox-design-agent'),
    filePath('../../../design-studio/target/desktop-dev/futureox-design-agent'),
    filePath('../../../design-studio/target/release/futureox-design-agent'),
    filePath('../../../design-studio/target/debug/futureox-design-agent'),
  ].filter(Boolean)
  return names.find(candidate => existsSync(candidate))
}

function filePath(relative) {
  return new URL(relative, import.meta.url).pathname
}

function agentEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) || key.startsWith('GROK_ASSISTANT_')) delete env[key]
  }
  return env
}

let portCursor = 22000 + (process.pid % 20000)
const nextPort = () => portCursor++

async function executable(dir, name, body) {
  const file = path.join(dir, name)
  await writeFile(file, body)
  await chmod(file, 0o755)
  return file
}

async function expectBounded(run) {
  const crashes = []
  const onCrash = error => { crashes.push(error) }
  process.on('uncaughtException', onCrash)
  try {
    const started = Date.now()
    const result = await run()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(crashes.length, 0, crashes.map(error => error?.stack || String(error)).join('\n'))
    assert.equal(result.status, 'error')
    assert.equal(typeof result.code, 'string')
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
    assert.ok(Date.now() - started < 4000, `error reply took too long (${Date.now() - started}ms)`)
    return result
  } finally {
    process.off('uncaughtException', onCrash)
  }
}


const bin = builtAgent()

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

test('installed agent path replaces the debug cargo default', async () => {
  assert.equal(resolveDesignAgentBinary({ env: {}, resourcesRoot: '/app/dist', platform: 'linux' }), '/app/dist/bin/futureox-design-agent')
  assert.equal(resolveDesignAgentBinary({ env: {}, resourcesRoot: '/Resources', platform: 'win32' }), path.join('/Resources', 'bin', 'futureox-design-agent.exe'))
  assert.equal(resolveDesignAgentBinary({ env: { DESIGN_AGENT_BIN: '/opt/agent' }, resourcesRoot: '/app/dist' }), '/opt/agent')
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8')
  const verify = await readFile(new URL('../scripts/verify-package.mjs', import.meta.url), 'utf8')
  assert.equal(main.includes('target/debug/futureox-design-agent'), false)
  assert.match(main, /resolveDesignAgentBinary/)
  assert.match(build, /'futureox-design-agent'/)
  assert.match(build, /agentBinary/)
  assert.match(verify, /futureox-design-agent/)
})

test('missing agent, early exit, a taken port, and a failed health check stay bounded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-agent-fault-'))
  const hosts = []
  try {
    const missing = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: path.join(dir, 'missing-futureox-design-agent'), port: nextPort(), env: agentEnv(), readyTimeoutMs: 500, pollMs: 20 })
      hosts.push(host)
      return Promise.all([host.status(), host.turn({ session_id: 'missing', message: '一键出图' })]).then(([status, turn]) => {
        assert.equal(turn.status, 'error')
        assert.equal(turn.code, 'AGENT_BIN')
        assert.match(turn.message, /未找到设计助手程序/)
        return status
      })
    })
    assert.equal(missing.code, 'AGENT_BIN')
    const empty = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: '', port: nextPort(), readyTimeoutMs: 200 })
      hosts.push(host)
      return host.status()
    })
    assert.equal(empty.code, 'AGENT_BIN')

    const earlyBin = await executable(dir, 'early-agent', '#!/bin/sh\necho agent-left-early >&2\nexit 9\n')
    const early = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: earlyBin, port: nextPort(), env: agentEnv(), readyTimeoutMs: 1000, pollMs: 20 })
      hosts.push(host)
      return host.status()
    })
    assert.equal(early.code, 'AGENT_EXIT')
    assert.match(early.message, /agent-left-early/)

    const portBin = await executable(dir, 'port-agent', '#!/bin/sh\necho "AGENT_PORT 127.0.0.1:1 Address already in use (os error 98)" >&2\nexit 1\n')
    const taken = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: portBin, port: nextPort(), env: agentEnv(), readyTimeoutMs: 1000, pollMs: 20 })
      hosts.push(host)
      return host.status()
    })
    assert.equal(taken.code, 'AGENT_PORT')
    assert.match(taken.message, /已被占用/)

    const healthPort = nextPort()
    const healthBin = await executable(dir, 'health-agent.mjs', `#!/usr/bin/env node
import http from 'node:http'
const bind = process.argv.find((arg, index, all) => all[index - 1] === '--bind')
const port = Number(String(bind).split(':').pop())
http.createServer((_req, res) => {
  res.writeHead(503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false }))
}).listen(port, '127.0.0.1')
`)
    const health = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: healthBin, port: healthPort, env: agentEnv(), readyTimeoutMs: 1000, pollMs: 20 })
      hosts.push(host)
      return host.status()
    })
    assert.equal(health.code, 'AGENT_HEALTH')
    assert.match(health.message, /健康检查/)

    const silentBin = await executable(dir, 'silent-agent', '#!/bin/sh\nsleep 30\n')
    const timeout = await expectBounded(() => {
      const host = createDesignAgentHost({ bin: silentBin, port: nextPort(), env: agentEnv(), readyTimeoutMs: 220, pollMs: 20 })
      hosts.push(host)
      return host.status()
    })
    assert.equal(timeout.code, 'AGENT_TIMEOUT')
    assert.match(timeout.message, /没有在/)
  } finally {
    for (const host of hosts) host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})


test('the installed agent turns a taken port into a bounded reply', async () => {
  const bin = builtAgent()
  assert.ok(bin, 'futureox-design-agent is not installed. Build the desktop app or cargo build -p futureox-design-agent.')
  const sockets = new Set()
  const server = createNetServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.destroy()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const host = createDesignAgentHost({ bin, port: address.port, env: agentEnv(), readyTimeoutMs: 4000, pollMs: 20 })
  try {
    const status = await expectBounded(() => host.status())
    assert.equal(status.code, 'AGENT_PORT')
    assert.match(status.message, /AGENT_PORT/)
    assert.match(status.message, /已被占用/)
  } finally {
    host.dispose()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
})

test('two agent instances do not adopt the health of the instance already holding the port', async () => {
  const bin = builtAgent(); assert.ok(bin)
  const port = nextPort(), first = createDesignAgentHost({ bin, port, env: agentEnv(), readyTimeoutMs: 1500 }), second = createDesignAgentHost({ bin, port, env: agentEnv(), readyTimeoutMs: 1500 })
  try {
    assert.equal((await first.status()).status, 'ok')
    const rejected = await second.status()
    assert.equal(rejected.status, 'error')
    assert.equal(rejected.code, 'AGENT_PORT')
    assert.equal((await first.status()).status, 'ok')
  } finally { second.dispose(); first.dispose() }
})
