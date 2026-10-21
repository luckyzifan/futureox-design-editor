// Optional real official SDK + actual unchanged CLI + production local bridge.
// The bridge dispatch uses a deterministic document fixture, NOT an Editor/GUI.
// Set MCP_OFFICIAL_SDK_ROOT to an already installed @modelcontextprotocol/client
// v2 project. No installation, network access or dependency mutation is done here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { LocalAutomationBridge } from '../../design-desktop/src/automation-bridge.mjs'
const sdkRoot = process.env.MCP_OFFICIAL_SDK_ROOT
const sdk = sdkRoot ? createRequire(path.join(sdkRoot, 'package.json')) : undefined
const Client = sdk?.('@modelcontextprotocol/client').Client
const StdioClientTransport = sdk?.('@modelcontextprotocol/client/stdio').StdioClientTransport
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const methods = [
  { name: 'document.inspect', description: 'Inspect fixture', mutates: false, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'document.export', description: 'Export fixture', mutates: false, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]
for (const mode of ['auto', 'pinned-modern', 'legacy']) test(`official SDK ${mode}: unchanged CLI and production bridge`, { skip: !sdkRoot, timeout: 20000 }, async t => {
  let capabilityReads = 0, executes = 0
  const bridge = new LocalAutomationBridge({ dispatch: async payload => {
    if (payload.kind === 'capabilities') { capabilityReads++; return { capabilities: { version: 1, methods, limits: {}, unsupported: [] }, documentId: 'fixture', session: 1, revision: 1 } }
    executes++
    const method = payload.request.method
    return { ok: true, method, documentId: 'fixture', session: 1, revision: 1, result: method === 'document.export'
      ? { format: 'futureox.design-document.v1', mimeType: 'application/json', content: '{"fixture":true}' }
      : { source: 'deterministic fixture, not product Editor' } }
  } })
  bridge.setEditor({ documentId: 'fixture', session: 1, name: 'SDK fixture', methods })
  await bridge.enable('read')
  t.after(() => bridge.close())
  const connection = bridge.connection()
  const options = mode === 'auto' ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 3000, maxRetries: 0 } } }
    : mode === 'pinned-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
  const client = new Client({ name: 'futureox-official-validation', version: '1' }, options)
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: {
    PATH: process.env.PATH, FUTUREOX_DESIGN_SOCKET: connection.endpoint, FUTUREOX_DESIGN_SESSION: connection.sessionId, FUTUREOX_DESIGN_BRIDGE_TOKEN: connection.token,
  }, stderr: 'pipe' })
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk })
  const frames = []
  const originalSend = transport.send.bind(transport)
  transport.send = (message, ...rest) => { frames.push({ direction: 'client', message }); return originalSend(message, ...rest) }
  let listener
  Object.defineProperty(transport, 'onmessage', { configurable: true, get() { return listener }, set(callback) {
    listener = callback ? ((message, ...rest) => { frames.push({ direction: 'server', message }); return callback(message, ...rest) }) : undefined
  } })
  try {
    await client.connect(transport)
    assert.equal(client.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern')
    // Auto probe may spawn another process; neither probe nor actual discovery
    // may authenticate to the bridge or consume the single-use token.
    assert.equal(capabilityReads, 0); assert.equal(executes, 0)
    assert.equal(bridge.status().connectedClients, 0)
    assert.equal((await client.listPrompts()).prompts.length, 2)
    assert.equal(capabilityReads, 0)
    assert.equal((await client.listTools()).tools.length, 2)
    assert.equal(capabilityReads, 1)
    const inspected = await client.callTool({ name: 'design_document_inspect', arguments: {} })
    assert.equal(inspected.structuredContent.result.source, 'deterministic fixture, not product Editor')
    const exported = await client.callTool({ name: 'design_document_export', arguments: {} })
    const link = exported.content.find(c => c.type === 'resource_link'); assert.ok(link)
    assert.equal((await client.readResource({ uri: link.uri })).contents[0].text, '{"fixture":true}')
    const resources = (await client.listResources()).resources
    assert.equal(resources.some(r => r.uri === link.uri), mode === 'legacy')
    const caps = await client.readResource({ uri: 'futureox-design://automation/capabilities' })
    assert.equal(JSON.parse(caps.contents[0].text).protocolVersion, mode === 'legacy' ? '2025-11-25' : '2026-07-28')
    await assert.rejects(client.readResource({ uri: 'futureox-design://missing' }), error => error.code === (mode === 'legacy' ? -32002 : -32602))
    const replies = frames.filter(f => f.direction === 'server' && f.message.result).map(f => f.message.result)
    assert.ok(replies.length > 0)
    assert.equal(replies.every(r => r.resultType === 'complete'), mode !== 'legacy')
    if (mode !== 'legacy') {
      assert.ok(frames.some(f => f.direction === 'client' && f.message.method === 'tools/list' && f.message.params._meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'))
      assert.ok(replies.some(r => Array.isArray(r.tools) && r.ttlMs === 0 && r.cacheScope === 'private'))
      assert.equal(frames.some(f => f.direction === 'client' && f.message.method === 'initialize'), false)
    }
    assert.equal(capabilityReads, 1); assert.equal(executes, 2)
  } finally {
    await client.close()
    assert.equal(stderr.includes(connection.token), false)
    if (process.env.MCP_EVIDENCE_DIR) {
      await mkdir(process.env.MCP_EVIDENCE_DIR, { recursive: true })
      await writeFile(path.join(process.env.MCP_EVIDENCE_DIR, `official-${mode}.json`), JSON.stringify({ mode, boundary: 'official SDK + production CLI/socket bridge; deterministic document dispatch; no GUI or real Editor', capabilityReads, executes, frames, stderr }, null, 2) + '\n')
    }
  }
})
