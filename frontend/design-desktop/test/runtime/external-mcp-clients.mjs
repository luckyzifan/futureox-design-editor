// Per-client acceptance for a packaged Futureox MCP stdio config.
// Missing clients are missing_environment. A tools/list from the packaged GUI
// harness is not a client pass. Tokens must not appear in the report or errors.
import { spawnSync } from 'node:child_process'

export const EXTERNAL_CLIENTS = [
  { id: 'claude-code', title: 'Claude Code', commands: ['claude'] },
  { id: 'codex', title: 'Codex', commands: ['codex'] },
  { id: 'kimi-code', title: 'Kimi Code CLI', commands: ['kimi'] },
  { id: 'kimi-cli-1', title: 'Kimi CLI 1.x', commands: ['kimi-cli'] },
  { id: 'dsh', title: 'DeepSeek Harness', commands: ['dsh'] },
]

export function redact(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]')
  }
  return text
}

export function commandPath(command, env = process.env) {
  const child = spawnSync('command', ['-v', command], {
    encoding: 'utf8',
    env,
    shell: true,
  })
  if (child.status !== 0) return null
  const found = child.stdout.trim().split('\n').at(-1)
  return found || null
}

export function probeExternalClients({ env = process.env, lookup = commandPath } = {}) {
  return EXTERNAL_CLIENTS.map(client => {
    const found = client.commands
      .map(command => ({ command, path: lookup(command, env) }))
      .find(item => item.path)
    if (!found) {
      return {
        id: client.id,
        title: client.title,
        status: 'missing_environment',
        evidence: 'command not on PATH',
      }
    }
    if (env.FUTUREOX_MCP_CLIENT_LIVE !== '1') {
      return {
        id: client.id,
        title: client.title,
        status: 'present_not_exercised',
        command: found.command,
        evidence: 'binary is on PATH; live handshake was not requested',
      }
    }
    return {
      id: client.id,
      title: client.title,
      status: 'not_run',
      command: found.command,
      evidence: 'FUTUREOX_MCP_CLIENT_LIVE=1 still needs a packaged executable and a human client session',
    }
  })
}

export async function verifyExternalClients(config, _tempDir, options = {}) {
  const token = config?.env?.FUTUREOX_DESIGN_BRIDGE_TOKEN
  const clients = probeExternalClients(options)
  if (options.packagedGuiToolsList === true) {
    // Recorded so a caller cannot confuse the GUI harness with client acceptance.
  }
  const report = {
    schema: 1,
    issue: 84,
    classification: 'acceptance_gap',
    confirmedRuntimeFault: false,
    packagedInstaller: options.packagedExecutable ? 'supplied_not_a_client_pass' : 'not_supplied',
    packagedGuiToolsListIsClientAcceptance: false,
    clients: clients.map(client => ({ id: client.id, title: client.title, status: client.status, evidence: client.evidence })),
  }
  const failed = clients.filter(client => client.status === 'failed')
  if (failed.length > 0) {
    throw new Error(redact(`External MCP client failed: ${failed.map(client => client.id).join(',')}`, [token]))
  }
  const serialized = redact(report, [token])
  if (token && serialized.includes(token)) throw new Error('MCP acceptance report leaked a bridge token')
  return JSON.parse(serialized)
}
