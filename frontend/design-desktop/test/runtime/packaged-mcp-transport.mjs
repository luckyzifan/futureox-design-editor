// Run against installed resources and the real bundled Electron executable.
// Only editor dispatch is a fixture; the companion GUI test exercises the mounted Editor.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function stdioClient(command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const lines = createInterface({ input: child.stdout }), pending = new Map()
  const exit = once(child, 'close').catch(() => {})
  child.stderr.resume()
  child.stdin.on('error', () => {})
  let id = 0
  const failed = () => { for (const { reject } of pending.values()) reject(Error('MCP child closed or sent invalid JSON')); pending.clear() }
  child.on('error', failed); child.on('close', failed)
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { failed(); child.kill(); return }
    const waiter = pending.get(message.id)
    if (waiter) { pending.delete(message.id); waiter.resolve(message) }
  })
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  return {
    async rpc(method, params = {}) {
      const requestId = ++id
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('MCP timed out: ' + method)), 15000)
          pending.set(requestId, { resolve, reject }); send({ id: requestId, method, params })
        })
      } finally { clearTimeout(timer); pending.delete(requestId) }
    },
    async init() {
      const r = await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packaged-local-test', version: '1' } })
      assert.equal(r.result?.protocolVersion, '2025-11-25')
      send({ method: 'notifications/initialized' })
    },
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2500)
      try { await exit } finally { clearTimeout(timer); lines.close() }
    },
  }
}
export async function verifyPackagedMcpTransport({ resources, executable, hostSource }) {
  const host = name => import(pathToFileURL(path.join(hostSource, 'src', name)).href)
  const { LocalAutomationBridge } = await host('automation-bridge.mjs')
  const { startDesktopFigmaMcp, desktopMcpPaths, desktopMcpClientConfig } = await host('figma-mcp-host.mjs')
  const methods = [{ name: 'vector.export', description: 'export this fixture', inputSchema: { type: 'object' }, mutates: false }]
  const target = { documentId: 'packaged-test-document', session: 1, revision: 0 }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Packaged MCP</title></svg>'
  const bridge = new LocalAutomationBridge({ dispatch: async p => p.kind === 'capabilities'
    ? { ...target, capabilities: { version: 1, methods } }
    : { ok: true, ...target, method: p.request.method, result: { format: 'futureox.design-vector.v1', mimeType: 'image/svg+xml', filename: 'design.svg', encoding: 'text', content: svg } } })
  const clients = []
  let http
  try {
    bridge.setEditor({ documentId: target.documentId, session: target.session, name: 'Transport fixture', methods })
    const grant = await bridge.enable('read')
    http = await startDesktopFigmaMcp(grant, resources)
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + grant.token }
    const post = async message => fetch(http.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...message }), signal: AbortSignal.timeout(8000) })
    assert.equal((await (await post({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package', version: '1' } } })).json()).result.protocolVersion, '2025-11-25')
    await post({ method: 'notifications/initialized' })
    const listed = await (await post({ id: 2, method: 'tools/list' })).json()
    assert.ok(listed.result.tools.some(t => t.name === 'download_assets'))
    const endpoints = desktopMcpPaths(resources)
    const config = desktopMcpClientConfig(grant, endpoints.cli, executable).mcpServers.futureox_design
    for (const [entry, name, args] of [[endpoints.cli, 'design_vector_export', { params: {} }], [path.join(path.dirname(endpoints.cli), 'figma-cli.mjs'), 'download_assets', { nodeId: 'test', defaultFormat: 'svg' }]]) {
      const client = stdioClient(config.command, [entry], config.env)
      clients.push(client); await client.init()
      assert.ok((await client.rpc('tools/list')).result.tools.some(t => t.name === name))
      const call = await client.rpc('tools/call', { name, arguments: args })
      assert.equal(call.result.isError, false)
      client.uri = call.result.content.find(x => x.type === 'resource_link').uri
      assert.equal((await client.rpc('resources/read', { uri: client.uri })).result.contents[0].text, svg)
    }
    await bridge.close()
    for (const client of clients) assert.equal((await client.rpc('resources/read', { uri: client.uri })).error?.code, -32000)
    assert.equal((await (await post({ id: 3, method: 'resources/list' })).json()).error?.code, -32000)
  } finally {
    await Promise.allSettled(clients.map(client => client.close())); await http?.close(); await bridge.close()
  }
}
