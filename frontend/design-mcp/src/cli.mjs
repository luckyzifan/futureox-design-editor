#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { DesignMcpServer } from './server.mjs'
import { SocketDesignBackend } from './socket-backend.mjs'

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
    process.stderr.write('Futureox Design MCP (stdio, MCP 2025-11-25)\nUsage: node src/cli.mjs --socket ABSOLUTE_SOCKET_PATH --session SESSION_ID\nToken: FUTUREOX_DESIGN_BRIDGE_TOKEN environment variable (ephemeral; never passed as an argument).\nOnly connects to an explicitly enabled local desktop design session. No TCP port, rendering, shell or document storage.\n')
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`[futureox-design-mcp] ${error.message}\n`); process.exitCode = 1 })
}
