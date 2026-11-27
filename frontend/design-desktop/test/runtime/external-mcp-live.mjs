// Live transport acceptance for installed external MCP clients.
// The client's own stdio path starts the packaged adapter and talks to the
// running packaged editor. This is not a model conversation: read, edit,
// screenshot and undo use only the client transport (Claude reports the
// connection health check; Kimi's bundled fastmcp client calls the tools).
import { spawnSync as defaultSpawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandPath, redact } from './external-mcp-clients.mjs'

const actionsFixture = fileURLToPath(new URL('kimi_mcp_actions.py', import.meta.url))

export const LIVE_STEPS = ['handshake', 'read', 'edit', 'screenshot', 'undo', 'revoke_rejects_old_resource']

function step(id, status, evidence = null) {
  return { id, status, ...(evidence ? { evidence } : {}) }
}

export function parseClaudeConnection(output) {
  return /Status:\s*(?:✓\s*)?Connected\b/.test(String(output ?? ''))
}

export function parseKimiToolCount(output) {
  const match = String(output ?? '').match(/Available tools:\s*(\d+)/)
  return match ? Number(match[1]) : null
}

export function claudeConfig(config) {
  return {
    mcpServers: {
      futureox_design: {
        type: 'stdio',
        command: config.command,
        args: [...(config.args ?? [])],
        env: { ...(config.env ?? {}) },
      },
    },
  }
}

export function kimiConfig(config) {
  return {
    mcpServers: {
      futureox_design: {
        command: config.command,
        args: [...(config.args ?? [])],
        env: { ...(config.env ?? {}) },
      },
    },
  }
}

export function interpreterFromLauncher(file) {
  let first = ''
  try { first = readFileSync(file, 'utf8').split('\n', 1)[0] } catch { return null }
  if (!first.startsWith('#!')) return null
  const value = first.slice(2).trim().split(/\s+/)[0]
  return path.isAbsolute(value) ? value : null
}

function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

function cleanOutput(value, token) {
  const text = redact(String(value ?? ''), [token])
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

function run(spawnSync, command, args, options) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...options,
  })
}

function claudeReport({ spawnSync, lookup, config, tempDir, env, token }) {
  const command = lookup('claude', env)
  if (!command) {
    return { id: 'claude-code', title: 'Claude Code', status: 'missing_environment', evidence: 'command not on PATH', steps: LIVE_STEPS.map(id => step(id, 'not_run', 'client is not installed')) }
  }
  const directory = path.join(tempDir, 'live-claude-code')
  const configPath = path.join(directory, '.claude.json')
  writePrivateJson(configPath, claudeConfig(config))
  const result = run(spawnSync, command, ['mcp', 'get', 'futureox_design'], {
    env: { ...env, CLAUDE_CONFIG_DIR: directory },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const connected = result.status === 0 && parseClaudeConnection(output)
  return {
    id: 'claude-code',
    title: 'Claude Code',
    status: connected ? 'transport_passed' : 'failed',
    evidence: connected
      ? 'claude mcp get reported the packaged stdio server as connected'
      : (cleanOutput(output, token).trim().split('\n').slice(0, 4).join('\n') || `exit ${result.status}`),
    steps: [
      step('handshake', connected ? 'passed' : 'failed'),
      ...LIVE_STEPS.slice(1).map(id => step(id, 'not_run', 'Claude Code health check does not expose a model-free tool call; the packaged stdio adapter actions are recorded by the GUI harness')),
    ],
  }
}

function kimiReport({ spawnSync, lookup, config, tempDir, env, token }) {
  const command = lookup('kimi-cli', env) ?? lookup('kimi', env)
  if (!command) {
    return { id: 'kimi-cli-1', title: 'Kimi CLI 1.x', status: 'missing_environment', evidence: 'command not on PATH', steps: LIVE_STEPS.map(id => step(id, 'not_run', 'client is not installed')) }
  }
  const share = path.join(tempDir, 'live-kimi-cli')
  const configPath = path.join(share, 'mcp.json')
  writePrivateJson(configPath, kimiConfig(config))
  const result = run(spawnSync, command, ['mcp', 'test', 'futureox_design'], { env: { ...env, KIMI_SHARE_DIR: share } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tools = result.status === 0 ? parseKimiToolCount(output) : null
  if (tools === null) {
    return {
      id: 'kimi-cli-1',
      title: 'Kimi CLI 1.x',
      status: 'failed',
      evidence: cleanOutput(output, token).trim().split('\n').slice(0, 4).join('\n') || `exit ${result.status}`,
      steps: LIVE_STEPS.map((id, index) => step(id, index === 0 ? 'failed' : 'not_run', 'kimi mcp test did not list tools')),
    }
  }
  const python = interpreterFromLauncher(command)
  const actions = python
    ? run(spawnSync, python, [actionsFixture, configPath], { env })
    : { status: 1, stdout: '', stderr: 'could not resolve the Kimi CLI Python interpreter' }
  let summary = null
  try { summary = JSON.parse(String(actions.stdout ?? '').trim().split('\n').at(-1)) } catch { summary = null }
  const actionSteps = ['read', 'edit', 'screenshot', 'undo'].map(id => step(id, summary?.[id] === true ? 'passed' : 'failed',
    summary?.[id] === true ? 'called through the Kimi CLI bundled fastmcp client' : cleanOutput(actions.stderr || actions.stdout, token).trim().split('\n').slice(0, 3).join('\n')))
  return {
    id: 'kimi-cli-1',
    title: 'Kimi CLI 1.x',
    status: actionSteps.every(item => item.status === 'passed') ? 'tools_passed' : 'transport_passed',
    evidence: `kimi mcp test listed ${tools} tools; ${summary ? 'bundled fastmcp client called document, edit, PNG and undo' : 'bundled fastmcp client actions did not complete'}`,
    tools,
    steps: [
      step('handshake', 'passed', `kimi mcp test listed ${tools} tools`),
      ...actionSteps,
      step('revoke_rejects_old_resource', 'not_run', 'requires a client session held across revocation; the packaged GUI session records the resource check'),
    ],
  }
}

export function runLiveExternalClients(config, { tempDir, env = process.env, spawnSync = defaultSpawnSync, lookup = commandPath, token } = {}) {
  if (!config?.command || !Array.isArray(config.args)) throw new Error('A packaged stdio config is required')
  if (!tempDir) throw new Error('A private temporary directory is required')
  const secret = token ?? config.env?.FUTUREOX_DESIGN_BRIDGE_TOKEN
  const clients = [
    claudeReport({ spawnSync, lookup, config, tempDir, env, token: secret }),
    kimiReport({ spawnSync, lookup, config, tempDir, env, token: secret }),
  ]
  if (JSON.stringify(clients).includes('FUTUREOX_DESIGN_BRIDGE_TOKEN') || (secret && JSON.stringify(clients).includes(secret))) {
    throw new Error('Live client report included a credential')
  }
  return { clients }
}

export function verifyOldConfigAfterRevoke(config, { tempDir, env = process.env, spawnSync = defaultSpawnSync, lookup = commandPath, token } = {}) {
  const secret = token ?? config.env?.FUTUREOX_DESIGN_BRIDGE_TOKEN
  const command = lookup('kimi-cli', env) ?? lookup('kimi', env)
  if (!command) return { status: 'missing_environment', evidence: 'Kimi CLI is not installed' }
  const share = path.join(tempDir, 'revoked-kimi-cli')
  writePrivateJson(path.join(share, 'mcp.json'), kimiConfig(config))
  const result = run(spawnSync, command, ['mcp', 'test', 'futureox_design'], { env: { ...env, KIMI_SHARE_DIR: share } })
  const output = cleanOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`, secret)
  const accepted = result.status === 0 && parseKimiToolCount(output) !== null
  return {
    status: accepted ? 'accepted' : 'rejected',
    evidence: accepted ? 'the revoked config still listed tools' : output.trim().split('\n').slice(0, 4).join('\n') || `exit ${result.status}`,
  }
}