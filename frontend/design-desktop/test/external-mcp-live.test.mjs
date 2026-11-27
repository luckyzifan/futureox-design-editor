import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  claudeConfig,
  interpreterFromLauncher,
  kimiConfig,
  parseClaudeConnection,
  parseKimiToolCount,
  runLiveExternalClients,
  verifyOldConfigAfterRevoke,
} from './runtime/external-mcp-live.mjs'

const token = 'secret-token-value'
const config = { command: '/pkg/futureox-desgin', args: ['/pkg/design-mcp/src/cli.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', FUTUREOX_DESIGN_BRIDGE_TOKEN: token } }

function fakeLauncher(directory) {
  const file = path.join(directory, 'kimi-cli')
  writeFileSync(file, '#!/usr/bin/python3\n', { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

test('client config wrappers keep the packaged stdio command and env', () => {
  assert.deepEqual(claudeConfig(config).mcpServers.futureox_design, { type: 'stdio', command: config.command, args: config.args, env: config.env })
  assert.deepEqual(kimiConfig(config).mcpServers.futureox_design, { command: config.command, args: config.args, env: config.env })
})

test('client output parsers require a real connection or tool count', () => {
  assert.equal(parseClaudeConnection('Status: ✓ Connected'), true)
  assert.equal(parseClaudeConnection('Status: ✗ Failed to connect'), false)
  assert.equal(parseKimiToolCount('✓ Connected to \'futureox_design\'\nAvailable tools: 136'), 136)
  assert.equal(parseKimiToolCount('Testing connection...\nfailed'), null)
})

test('a live report records Kimi tool actions without exposing the bridge token', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fx-live-clients-'))
  try {
    const launcher = fakeLauncher(directory)
    const calls = []
    const spawnSync = (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'mcp' && args[1] === 'get') return { status: 0, stdout: 'Status: ✓ Connected', stderr: '' }
      if (args[0] === 'mcp' && args[1] === 'test') return { status: 0, stdout: "✓ Connected to 'futureox_design'\nAvailable tools: 136\n", stderr: '' }
      if (args[0]?.endsWith('kimi_mcp_actions.py')) return { status: 0, stdout: '{"read":true,"edit":true,"screenshot":true,"undo":true}\n', stderr: '' }
      return { status: 1, stdout: '', stderr: 'unexpected' }
    }
    const report = runLiveExternalClients(config, {
      tempDir: directory,
      env: { PATH: directory },
      lookup: command => command === 'claude' ? '/usr/bin/claude' : launcher,
      spawnSync,
    })
    const claude = report.clients.find(client => client.id === 'claude-code')
    const kimi = report.clients.find(client => client.id === 'kimi-cli-1')
    assert.equal(claude.status, 'transport_passed')
    assert.equal(claude.steps.find(item => item.id === 'handshake').status, 'passed')
    assert.equal(claude.steps.find(item => item.id === 'edit').status, 'not_run')
    assert.equal(kimi.status, 'tools_passed')
    for (const id of ['handshake', 'read', 'edit', 'screenshot', 'undo']) {
      assert.equal(kimi.steps.find(item => item.id === id).status, 'passed', id)
    }
    assert.equal(kimi.steps.find(item => item.id === 'revoke_rejects_old_resource').status, 'not_run')
    assert.equal(JSON.stringify(report).includes(token), false)
    assert.equal(calls.some(call => call.some(value => value.includes(token))), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing clients stay missing instead of borrowing another client result', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fx-live-missing-'))
  try {
    const report = runLiveExternalClients(config, {
      tempDir: directory,
      env: { PATH: directory },
      lookup: () => null,
      spawnSync: () => { throw new Error('must not spawn') },
    })
    assert.equal(report.clients.every(client => client.status === 'missing_environment'), true)
    assert.equal(report.clients.every(client => client.steps.every(item => item.status === 'not_run')), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed Kimi tool action cannot report a tools pass', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fx-live-fail-'))
  try {
    const launcher = fakeLauncher(directory)
    const report = runLiveExternalClients(config, {
      tempDir: directory,
      env: { PATH: directory },
      lookup: command => command === 'kimi-cli' ? launcher : null,
      spawnSync: (_command, args) => args[0] === 'mcp'
        ? { status: 0, stdout: "Available tools: 136\n", stderr: '' }
        : { status: 1, stdout: '', stderr: 'design_preview_capture did not return PNG bytes\n' },
    })
    const kimi = report.clients.find(client => client.id === 'kimi-cli-1')
    assert.equal(kimi.status, 'transport_passed')
    assert.equal(kimi.steps.find(item => item.id === 'screenshot').status, 'failed')
    assert.equal(JSON.stringify(report).includes(token), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the launcher shebang supplies the Kimi interpreter only when it is absolute', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fx-live-shebang-'))
  try {
    assert.equal(interpreterFromLauncher(fakeLauncher(directory)), '/usr/bin/python3')
    const plain = path.join(directory, 'plain')
    writeFileSync(plain, 'not a script\n')
    assert.equal(interpreterFromLauncher(plain), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a revoked Kimi config that still lists tools is reported as accepted', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fx-live-revoked-'))
  try {
    const launcher = fakeLauncher(directory)
    const accepted = verifyOldConfigAfterRevoke(config, {
      tempDir: directory,
      env: { PATH: directory },
      lookup: () => launcher,
      spawnSync: () => ({ status: 0, stdout: 'Available tools: 136\n', stderr: '' }),
    })
    assert.equal(accepted.status, 'accepted')
    const rejected = verifyOldConfigAfterRevoke(config, {
      tempDir: directory,
      env: { PATH: directory },
      lookup: () => launcher,
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'Authorization is no longer active\n' }),
    })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.evidence.includes(token), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})