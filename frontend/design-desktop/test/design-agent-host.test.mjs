import assert from 'node:assert/strict'
import { createServer } from 'node:net'
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

test('desktop host stores an API and a token plan, switches them, and reads CC Switch without echoing secrets', async () => {
  const bin = builtAgent()
  assert.ok(bin, 'futureox-design-agent is not installed. Build the desktop app or cargo build -p futureox-design-agent.')
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
    env: agentEnv({ CCSWITCH_DB: db }),
  })
  try {
    const local = await host.status()
    assert.equal(local.status, 'ok', local.message)
    assert.equal(local.mode, 'local')
    assert.equal(local.label, '本机模式')
    assert.equal(local.providers.some(item => item.id === 'local' && item.active && item.kind === 'local' && item.has_secret === false && item.name === '本机模式'), true)
    const generated = await host.turn({
      session_id: 'local-page',
      message: '一键出图：做一个可编辑的产品落地页，标题、副标题和三个卖点',
      history: [],
      context: { current_page_id: 'page-1', target_page_id: 'page-1', pages: [{ id: 'page-1', name: '页面' }], nodes: [], selection: [] },
    })
    assert.equal(generated.status, 'ok', generated.message)
    assert.equal(generated.turn.assistant, '本机模式')
    assert.equal(generated.turn.operations.some(item => item.method === 'page.create'), true)
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
    const again = createDesignAgentHost({ bin, port: 39285, storePath: path.join(dir, 'providers.json'), env: agentEnv() })
    try {
      const restored = await again.status()
      assert.equal(restored.providers.some(item => item.id === 'shop-plan' && item.has_secret), true)
    } finally { again.dispose() }
  } finally {
    host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the installed agent turns a taken port into a bounded reply', async () => {
  const bin = builtAgent()
  assert.ok(bin, 'futureox-design-agent is not installed. Build the desktop app or cargo build -p futureox-design-agent.')
  const sockets = new Set()
  const server = createServer(socket => {
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
