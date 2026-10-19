import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { parseOptions } from '../src/cli.mjs'
const token = 'ephemeral-test-token-1234567890'
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

test('CLI parser accepts explicit ephemeral configuration and refuses token arguments', () => {
  const options = parseOptions(['--socket', '/tmp/private/bridge.sock', '--session', 'sid'], { FUTUREOX_DESIGN_BRIDGE_TOKEN: token })
  assert.equal(options.endpoint, '/tmp/private/bridge.sock')
  assert.equal(options.token, token)
  assert.throws(() => parseOptions(['--token', token], {}), /environment/)
  assert.throws(() => parseOptions([], {}), /Enable the desktop/)
})
test('help and configuration errors write only stderr', async () => {
  for (const args of [['--help'], []]) {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const [code] = await once(child, 'exit')
    assert.equal(stdout, '')
    assert(stderr.length > 0)
    assert.equal(code, args.length ? 0 : 1)
  }
})
test('spawned stdio lifecycle works and a missing live backend fails honestly', async t => {
  const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, FUTUREOX_DESIGN_SOCKET: '/nonexistent-futureox-private/bridge.sock', FUTUREOX_DESIGN_SESSION: 'session', FUTUREOX_DESIGN_BRIDGE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let text = '', stderr = ''; const messages = []
  child.stdout.on('data', bytes => { text += bytes; let i; while ((i = text.indexOf('\n')) >= 0) { messages.push(JSON.parse(text.slice(0, i))); text = text.slice(i + 1) } })
  child.stderr.on('data', bytes => { stderr += bytes })
  const wait = async count => { const until = Date.now() + 3000; while (messages.length < count) { if (Date.now() > until) throw new Error('stdio response timeout'); await new Promise(resolve => setTimeout(resolve, 2)) }; return messages.at(-1) }
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cli-test', version: '1' } } })
  assert.equal((await wait(1)).result.protocolVersion, '2025-11-25')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }); assert.equal((await wait(2)).result.prompts.length, 2)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }); assert.equal((await wait(3)).error.code, -32603)
  assert.equal(stderr.includes(token), false)
  const exit = once(child, 'exit'); child.stdin.end(); assert.equal((await exit)[0], 0)
  assert.equal(text, '')
})
