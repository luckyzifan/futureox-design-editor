import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    assert.equal(status.ccswitch.proxy, 'http://127.0.0.1:15721/v1')
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
