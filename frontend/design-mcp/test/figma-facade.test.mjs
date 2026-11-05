import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_INSTRUCTIONS, FIGMA_MCP_TOOLS, FigmaFacade, metadataXml, registerFigmaPluginBridge, validateFigmaOperation } from '../src/figma-facade.mjs'

const METHODS = ['document.get', 'page.list', 'node.find', 'node.get', 'selection.get', 'context.get', 'code.export', 'preview.capture', 'variable.list', 'style.list', 'vector.export', 'batch.apply', 'workspace.open']

function facade(handlers, { scope = 'write', pluginBridge, methods = METHODS } = {}) {
  const calls = []
  const execute = async request => {
    calls.push(request)
    const handler = handlers[request.method]
    if (!handler) return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: 4, error: { code: 'missing', message: request.method } }
    const result = await handler(request)
    return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: result?.revision ?? 4, result }
  }
  return {
    calls,
    api: new FigmaFacade({
      execute, scope, pluginBridge,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' }, mutates: name === 'batch.apply' || name === 'workspace.open' })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }

test('advertised tools match the Figma-shaped subset and do not invent registry aliases', () => {
  assert.deepEqual(FIGMA_MCP_TOOLS.map(tool => tool.name), ['get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets', 'use_figma', 'open_document'])
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'whoami' && gap.status === 'absent'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'use_figma_plugin_javascript'))
  assert.equal(validateFigmaOperation({ op: 'create', kind: 'button' }), 'create kind must be one of slice, frame, section, group, rectangle, ellipse, polygon, star, line, vector, text')
})

test('metadata XML escapes names and nests by parent', () => {
  const xml = metadataXml('Doc', [
    { id: 'parent', name: 'A&B', kind: 'frame', width: 100, height: 40, worldBounds: { x: 1, y: 2 } },
    { id: 'child', name: 'Title', kind: 'text', parentId: 'parent', width: 10, height: 8 },
  ])
  assert.equal(xml, '<canvas name="Doc"><frame id="parent" name="A&amp;B" x="1" y="2" width="100" height="40"><text id="child" name="Title" width="10" height="8" /></frame></canvas>')
})

test('get_metadata lists pages, then a subtree, and ignores fileKey', async () => {
  const { api, calls } = facade({
    'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }),
    'node.find': request => ({ nodes: [{ id: request.params.rootId, name: 'Card', kind: 'frame', width: 20, height: 10 }], total: 1, nextCursor: null }),
  })
  const pages = ok(await api.callTool('get_metadata', { fileKey: 'figma-file' }, {}))
  assert.match(pages.result.modelText, /<page id="page-1" name="Cover"/)
  assert.equal(pages.result.fileKeyIgnored, true)
  const subtree = ok(await api.callTool('get_metadata', { nodeId: 'node-1' }, {}))
  assert.equal(calls.at(-1).params.rootId, 'node-1')
  assert.match(subtree.result.xml, /id="node-1"/)
  const cursor = await api.callTool('get_metadata', { cursor: 'next' }, {})
  assert.equal(cursor.error.code, 'invalid_params')
})

test('get_selection reads ids and summarizes at most the requested nodes', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['a', 'b'] }),
    'node.get': request => ({ id: request.params.id, name: request.params.id, kind: 'rectangle', width: 12, height: 8, node: { id: request.params.id } }),
  })
  const selected = ok(await api.callTool('get_selection', {}, {}))
  assert.deepEqual(selected.result.ids, ['a', 'b'])
  assert.deepEqual(selected.result.nodes.map(node => node.id), ['a', 'b'])
  assert.deepEqual(calls.map(call => call.method), ['selection.get', 'node.get', 'node.get'])
})

test('get_design_context asks for context and HTML/CSS without claiming React output', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['card'] }),
    'context.get': () => ({ nodes: [{ id: 'card', name: 'Card', kind: 'frame' }] }),
    'code.export': () => ({ html: '<main></main>', css: '.card{}', fidelity: 'approximate', warnings: [] }),
  })
  const result = ok(await api.callTool('get_design_context', { clientFrameworks: ['react'] }, {}))
  assert.equal(result.result.format, 'futureox.design-code.v1')
  assert.match(result.result.modelText, /not Figma React/)
  assert.equal(calls.some(call => call.method === 'code.export' && call.params.nodeIds[0] === 'card'), true)
})

test('get_screenshot and single-node download call the CPU export', async () => {
  const preview = { format: 'futureox.design-preview.v1', mimeType: 'image/png', width: 4, height: 4 }
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: [] }),
    'preview.capture': request => ({ ...preview, nodeIds: request.params.nodeIds, formatName: request.params.format }),
    'vector.export': () => ({ format: 'futureox.design-vector.v1', content: '<svg/>' }),
  })
  const shot = ok(await api.callTool('get_screenshot', {}, {}))
  assert.equal(shot.method, 'preview.capture')
  assert.equal(calls.at(-1).params.format, 'png')
  assert.equal(calls.at(-1).params.nodeIds, undefined)
  const png = ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'png' }, {}))
  assert.equal(png.result.rawImagesUnsupported, true)
  assert.equal(png.result.urls, false)
  const many = await api.callTool('download_assets', { nodeIds: ['a', 'b'] }, {})
  assert.equal(many.error.code, 'too_many_nodes')
  const pdf = await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'pdf' }, {})
  assert.equal(pdf.error.code, 'unsupported_format')
  ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'svg' }, {}))
  assert.equal(calls.at(-1).method, 'vector.export')
})

test('get_variable_defs keeps selection bindings and does not invent libraries', async () => {
  const { api } = facade({
    'selection.get': () => ({ ids: ['label'] }),
    'node.get': () => ({ node: { bindings: { fill: 'brand' }, styleRefs: { text: 'body' } } }),
    'variable.list': () => [{ id: 'brand', name: 'Brand' }, { id: 'gap', name: 'Gap' }],
    'style.list': () => [{ id: 'body', name: 'Body' }, { id: 'other', name: 'Other' }],
  })
  const defs = ok(await api.callTool('get_variable_defs', {}, {}))
  assert.deepEqual(defs.result.variables.map(item => item.id), ['brand'])
  assert.deepEqual(defs.result.styles.map(item => item.id), ['body'])
  assert.deepEqual(defs.result.libraries, [])
})

test('use_figma compiles structured writes into one batch and refuses plugin source without a bridge', async () => {
  const { api, calls } = facade({
    'document.get': () => ({ revision: 8 }),
    'node.get': () => ({ revision: 8, node: { transform: [1, 0, 0, 1, 10, 20] } }),
    'batch.apply': request => ({ applied: request.params.operations.length, revision: 9 }),
  }, { pluginBridge: null })
  const created = ok(await api.callTool('use_figma', {
    description: 'Add a label',
    operations: [
      { op: 'create', kind: 'rectangle', x: 0, y: 0, width: 100, height: 40, name: 'Card', fill: '#112233' },
      { op: 'update', nodeId: 'title', x: 30, text: 'Hello' },
      { op: 'select', nodeIds: [] },
    ],
  }, {}))
  assert.equal(created.result.revision, 9)
  const batch = calls.find(call => call.method === 'batch.apply')
  assert.equal(batch.expectedRevision, 8)
  assert.equal(batch.params.operations[0].method, 'node.create')
  assert.deepEqual(batch.params.operations[0].params.patch.fills[0], { kind: 'solid', color: '#112233', opacity: 1, angle: 0, stops: [] })
  assert.deepEqual(batch.params.operations[1], { method: 'node.patch', params: { ids: ['title'], patch: { transform: { x: 30 } } } })
  assert.equal(batch.params.operations[2].params.patch.text, 'Hello')
  assert.equal(batch.params.operations[3].method, 'selection.set')
  calls.length = 0
  const blocked = await api.callTool('use_figma', { description: 'Run plugin', code: 'FIGMA_PLUGIN_SOURCE_SENTINEL' }, {})
  assert.equal(blocked.error.code, 'plugin_host_unavailable')
  assert.equal(calls.length, 0)
  assert.equal(JSON.stringify(blocked).includes('FIGMA_PLUGIN_SOURCE_SENTINEL'), false)
})

test('registered plugin bridge receives source and the facade does not eval it', async () => {
  const seen = []
  const bridge = { run: async input => { seen.push(input.code); return { ok: true, method: 'use_figma', documentId: input.documentId, session: input.session, revision: input.revision, result: { forwarded: true } } } }
  registerFigmaPluginBridge(bridge)
  try {
    const { api, calls } = facade({ 'document.get': () => ({ revision: 2 }) })
    const result = ok(await api.callTool('use_figma', { description: 'Rename', code: 'figma.currentPage.selection' }, {}))
    assert.equal(result.result.forwarded, true)
    assert.deepEqual(seen, ['figma.currentPage.selection'])
    assert.deepEqual(calls.map(call => call.method), ['document.get'])
  } finally { registerFigmaPluginBridge(null) }
})

test('read-only scope rejects writes before calling the Design API', async () => {
  const { api, calls } = facade({}, { scope: 'read' })
  const write = await api.callTool('use_figma', { description: 'Edit', operations: [{ op: 'delete', nodeId: 'a' }] }, {})
  const open = await api.callTool('open_document', { rootHandle: 'root', documentHandle: 'doc', mutationId: 'open-1' }, {})
  assert.equal(write.error.code, 'read_only')
  assert.equal(open.error.code, 'read_only')
  assert.equal(calls.length, 0)
})

test('open_document reports a missing workspace grant and otherwise forwards handles', async () => {
  const missing = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.open') })
  const unavailable = await missing.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {})
  assert.equal(unavailable.error.code, 'open_unavailable')
  assert.equal(missing.calls.length, 0)
  const present = facade({
    'document.get': () => ({ revision: 5 }),
    'workspace.open': request => ({ handle: request.params.documentHandle, revision: 5 }),
  })
  present.api.methodNames.add('workspace.open')
  const opened = ok(await present.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {}))
  assert.equal(opened.result.handle, 'saved')
  assert.equal(present.calls.at(-1).params.mutationId, 'open-1')
  assert.equal(present.calls.at(-1).expectedRevision, 5)
})

test('stdio tool text for get_metadata is the XML outline', async t => {
  const { api } = facade({ 'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }) })
  const input = new PassThrough(), output = new PassThrough()
  let bytes = ''
  const messages = []
  output.on('data', chunk => { bytes += chunk; let index; while ((index = bytes.indexOf('\n')) !== -1) { messages.push(JSON.parse(bytes.slice(0, index))); bytes = bytes.slice(index + 1) } })
  const server = new DesignMcpServer({ input, output, diagnostics: new PassThrough(), backend: api, instructions: FIGMA_MCP_INSTRUCTIONS }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy() })
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  const wait = async count => { const end = Date.now() + 1000; while (messages.length < count) { if (Date.now() > end) throw new Error(`expected ${count}`); await delay(2) }; return messages.at(-1) }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'figma-client', version: '1' } } })
  const initialized = await wait(1)
  assert.match(initialized.result.instructions, /plugin_host_unavailable/)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_metadata', arguments: {} } })
  const call = await wait(2)
  assert.equal(call.result.isError, false)
  assert.match(call.result.content[0].text, /^<canvas /)
  assert.equal(call.result.structuredContent.result.modelText, undefined)
})
