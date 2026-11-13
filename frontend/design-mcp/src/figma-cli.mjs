#!/usr/bin/env node
import { DesignMcpServer } from './server.mjs'
import { SocketDesignBackend } from './socket-backend.mjs'
import { FIGMA_MCP_INSTRUCTIONS, FigmaFacade } from './figma-facade.mjs'
import { isDirectInvocation, parseOptions } from './cli.mjs'

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (options.help) {
    process.stderr.write('Futureox Design Figma-shaped MCP (stdio, MCP 2025-11-25)\nUsage: <packaged Electron or Node> <design-mcp>/src/figma-cli.mjs\nToken: FUTUREOX_DESIGN_BRIDGE_TOKEN environment variable.\nTools follow common Figma MCP names and call the existing Design API. The full design_* catalog remains src/cli.mjs.\n')
    return
  }
  const socket = new SocketDesignBackend(options)
  const operation = await socket.connect()
  const backend = new FigmaFacade({
    execute: (request, context) => operation.execute(request, context),
    methods: operation.capabilities.methods,
    scope: operation.scope,
    target: operation.target,
    terminalSignal: socket.terminalSignal,
  })
  const server = new DesignMcpServer({ backend, instructions: FIGMA_MCP_INSTRUCTIONS }).start()
  const stop = () => { void server.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try { await server.done }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); socket.close() }
}

if (isDirectInvocation(import.meta.url)) {
  main().catch(error => { process.stderr.write(`[futureox-figma-mcp] ${error.message}\n`); process.exitCode = 1 })
}
