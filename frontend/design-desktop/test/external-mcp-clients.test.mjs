import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EXTERNAL_CLIENTS, commandPath, probeExternalClients, redact, verifyExternalClients } from './runtime/external-mcp-clients.mjs'
import { buildReport } from '../scripts/mcp-client-acceptance.mjs'

const TOKEN = 'bridge-token-sentinel-84'

test('missing clients stay missing and a tools list is not a pass', async () => {
  const report = await verifyExternalClients(
    { env: { FUTUREOX_DESIGN_BRIDGE_TOKEN: TOKEN } },
    '/tmp/unused',
    { lookup: () => null, packagedGuiToolsList: true, packagedExecutable: '/opt/futureox/futureox-desgin' },
  )
  assert.equal(report.packagedGuiToolsListIsClientAcceptance, false)
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(report.clients.length, EXTERNAL_CLIENTS.length)
  assert.equal(report.clients.every(client => client.status === 'missing_environment'), true)
  assert.equal(JSON.stringify(report).includes(TOKEN), false)
})

test('a binary on PATH is not marked connected without a live packaged handshake', () => {
  const clients = probeExternalClients({
    env: {},
    lookup: command => command === 'claude' ? '/usr/bin/claude' : null,
  })
  assert.equal(clients.find(client => client.id === 'claude-code').status, 'present_not_exercised')
  assert.equal(clients.find(client => client.id === 'codex').status, 'missing_environment')
  assert.equal(clients.some(client => client.status === 'passed'), false)
})

test('acceptance report redacts tokens and leaves the installer unlaunched', () => {
  const report = buildReport({
    env: { FUTUREOX_DESIGN_BRIDGE_TOKEN: TOKEN },
    lookup: () => null,
  })
  assert.equal(report.packagedInstaller.status, 'missing_environment')
  assert.equal(report.steps.every(step => step.status === 'not_run'), true)
  assert.equal(JSON.stringify(report).includes(TOKEN), false)
  assert.equal(redact(`token ${TOKEN}`, [TOKEN]).includes(TOKEN), false)
})

test('a client lookup exception cannot expose the configured bridge token', async () => {
  await assert.rejects(verifyExternalClients(
    { env: { FUTUREOX_DESIGN_BRIDGE_TOKEN: TOKEN } },
    '/tmp/unused',
    { lookup: () => { throw new Error(`lookup failed: ${TOKEN}`) } },
  ), error => !String(error).includes(TOKEN))
})

test('PATH lookup finds a real executable file without launching a client', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fx client path '))
  try {
    const executable = path.join(directory, process.platform === 'win32' ? 'codex.CMD' : 'codex')
    await writeFile(executable, 'exit 79\n', { mode: 0o755 })
    const env = { PATH: directory, PATHEXT: '.CMD' }
    assert.equal(commandPath('codex', env), executable)
    assert.equal(commandPath('missing-client', env), null)
    const clients = probeExternalClients({ env })
    assert.equal(clients.find(client => client.id === 'codex').status, 'present_not_exercised')
    assert.equal(clients.some(client => client.status === 'passed'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Windows command discovery respects semicolon PATH and case-insensitive PATHEXT keys', () => {
  const normalize = value => value.replaceAll(String.fromCharCode(92), '/')
  const found = commandPath('codex', { Path: 'C:/missing;C:/Tool Space', PathExt: '.EXE;.CMD' }, {
    platform: 'win32',
    isExecutable: file => normalize(file) === 'C:/Tool Space/codex.CMD',
  })
  assert.equal(normalize(found), 'C:/Tool Space/codex.CMD')
})
