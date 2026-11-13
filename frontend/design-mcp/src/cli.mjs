#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesignMcpServer } from './server.mjs'
import { SocketDesignBackend } from './socket-backend.mjs'

/**
 * True when this module is the process entry, including when the installed
 * package path reaches it through a symlink. Node realpaths the loaded module
 * for import.meta.url but leaves the symlink in argv, so a string compare
 * exits before any handshake.
 */
export function isDirectInvocation(moduleUrl, argv1 = process.argv[1], platform = process.platform) {
  if (typeof argv1 !== 'string' || argv1.length === 0 || argv1.startsWith('-')) return false
  let modulePath
  try { modulePath = fileURLToPath(moduleUrl) } catch { return false }
  const canonical = file => {
    const bare = platform === 'win32' && file.startsWith('\\\\?\\') ? file.slice(4) : file
    const absolute = path.resolve(bare)
    try { return realpathSync(absolute) } catch { return absolute }
  }
  const left = canonical(modulePath)
  const right = canonical(argv1)
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function parseOptions(argv, env = process.env) {
  const options = { endpoint: env.FUTUREOX_DESIGN_SOCKET, sessionId: env.FUTUREOX_DESIGN_SESSION, token: env.FUTUREOX_DESIGN_BRIDGE_TOKEN }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return { help: true }
    const key = flag === '--socket' ? 'endpoint' : flag === '--session' ? 'sessionId' : undefined
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --socket PATH and --session ID; supply the ephemeral token through the FUTUREOX_DESIGN_BRIDGE_TOKEN environment variable')
    options[key] = argv[++i]
  }
  if (!options.endpoint || !options.sessionId || !options.token) throw new Error('Enable the desktop AI bridge, then set FUTUREOX_DESIGN_SOCKET, FUTUREOX_DESIGN_SESSION and FUTUREOX_DESIGN_BRIDGE_TOKEN')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (options.help) {
    process.stderr.write('Futureox Design MCP (stdio, MCP 2025-11-25)\nUsage: <packaged Electron or Node> <design-mcp>/src/cli.mjs\nThe desktop app copies the executable, this script, and the environment. Token: FUTUREOX_DESIGN_BRIDGE_TOKEN (never an argument).\nOnly connects to an explicitly enabled local desktop design session. No TCP port, rendering, shell or document storage.\n')
    return
  }
  const backend = new SocketDesignBackend(options)
  const server = new DesignMcpServer({ backend }).start()
  const stop = () => { void server.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try { await server.done }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); backend.close() }
}

if (isDirectInvocation(import.meta.url)) {
  main().catch(error => { process.stderr.write(`[futureox-design-mcp] ${error.message}\n`); process.exitCode = 1 })
}
