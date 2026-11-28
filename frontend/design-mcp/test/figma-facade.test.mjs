import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_INSTRUCTIONS, FIGMA_MCP_TOOLS, FigmaFacade, metadataXml, registerFigmaPluginBridge, validateFigmaOperation } from '../src/figma-facade.mjs'
import { FIGMA_COMPATIBILITY_TOOLS } from '../src/figma-weave-tools.mjs'
import { FIGMA_DESKTOP_TOOL_NAMES, FIGMA_DESKTOP_WRITE_TOOLS } from '../src/figma-desktop-tools.mjs'
import { REMOTE_FIGMA_TOOLS } from '../src/figma-remote-tools.mjs'

const READ_DESKTOP_TOOL_NAMES = FIGMA_DESKTOP_TOOL_NAMES.filter(name => !FIGMA_DESKTOP_WRITE_TOOLS.has(name))
const READ_REMOTE_TOOL_NAMES = REMOTE_FIGMA_TOOLS.filter(entry => entry.annotations.readOnlyHint).map(entry => entry.name)

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
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'whoami' && gap.status === 'local'))
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

test('get_metadata continues the native query with the same nodeId and fresh read fences', async () => {
  const { api, calls } = facade({
    'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }),
    'node.find': ({ params }) => ({
      nodes: [{ id: params.cursor ? 'second' : 'first', kind: 'rectangle' }],
      total: 2,
      nextCursor: params.cursor ? null : '4:1',
    }),
  })
  const first = ok(await api.callTool('get_metadata', { nodeId: 'page-1', limit: 1 })).result
  assert.deepEqual(first.nodes.map(node => node.id), ['first'])
  assert.equal(first.truncated, true)
  assert.equal(typeof first.nextCursor, 'string')
  const second = ok(await api.callTool('get_metadata', { nodeId: 'page-1', limit: 1, cursor: first.nextCursor })).result
  assert.deepEqual(second.nodes.map(node => node.id), ['second'])
  assert.equal(second.nextCursor, null)
  assert.equal(second.truncated, false)
  assert.deepEqual(calls.at(-1), { method: 'node.find', params: { pageId: 'page-1', limit: 1, cursor: '4:1' }, documentId: 'doc-1', session: 3, expectedRevision: 4 })
  const mismatch = await api.callTool('get_metadata', { nodeId: 'another', cursor: first.nextCursor })
  assert.equal(mismatch.error.code, 'invalid_params')
  assert.equal(calls.at(-1).method, 'page.list')
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

test('a packaged stdio session assertion must match the authenticated grant', async () => {
  const calls = []
  const api = new FigmaFacade({ scope: 'read', localSessionId: 'desktop-grant-id', methods: [{ name: 'selection.get' }],
    execute: async request => {
      calls.push(request)
      return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: 4,
        result: { ids: [], pageId: 'page-1' } }
    },
  })
  assert.equal((await api.callTool('get_selection', { sessionId: 'another-grant' })).error.code, 'invalid_local_session')
  assert.equal((await api.callTool('get_selection', { sessionId: 3 })).error.code, 'invalid_local_session')
  assert.deepEqual(calls, [])
  ok(await api.callTool('get_selection', { sessionId: 'desktop-grant-id' }))
  assert.deepEqual(calls.map(request => request.params), [{}])
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
    'preview.capture': request => ({
      ...preview, nodeIds: request.params.nodeIds, formatName: request.params.format,
      ...(request.params.format === 'pdf' ? {
        mimeType: 'application/pdf',
        dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
      } : {}),
    }),
    'vector.export': () => ({ format: 'futureox.design-vector.v1', content: '<svg/>' }),
  })
  const shot = ok(await api.callTool('get_screenshot', {}, {}))
  assert.equal(shot.method, 'preview.capture')
  assert.equal(calls.at(-1).params.format, 'png')
  assert.equal(calls.at(-1).params.nodeIds, undefined)
  const png = ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'png' }, {}))
  assert.equal(png.result.rawImagesUnsupported, true)
  assert.equal(png.result.urls, false)
  const many = await api.callTool('download_assets', { nodeIds: Array.from({ length: 21 }, (_, i) => `node-${i}`) }, {})
  assert.equal(many.error.code, 'too_many_nodes')
  const pdf = ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'pdf' }, {}))
  assert.equal(pdf.result.mimeType, 'application/pdf')
  assert.deepEqual(calls.at(-1).params, { format: 'pdf', nodeIds: ['icon'] })
  ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'svg' }, {}))
  assert.equal(calls.at(-1).method, 'vector.export')
})

test('download_assets batches individual exports against one revision', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'preview.capture': request => ({
      format: 'futureox.design-preview.v1', mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${Buffer.from(request.params.nodeIds[0]).toString('base64')}`,
    }),
  })
  const result = ok(await api.callTool('download_assets', { nodeId: 'a', nodeIds: ['b', 'a'], defaultScale: 2 }, {}))
  assert.deepEqual(result.result.assets.map(asset => asset.nodeId), ['a', 'b'])
  assert.deepEqual(calls.map(call => call.method), ['document.get', 'preview.capture', 'preview.capture'])
  for (const request of calls.slice(1)) {
    assert.equal(request.documentId, 'doc-1')
    assert.equal(request.session, 3)
    assert.equal(request.expectedRevision, 4)
    assert.equal(request.params.scale, 2)
  }
  const stale = facade({
    'document.get': () => ({}),
    'vector.export': request => ({ content: '<svg/>', revision: request.params.nodeIds[0] === 'b' ? 5 : 4 }),
  }).api
  const failed = await stale.callTool('download_assets', { nodeIds: ['a', 'b'], defaultFormat: 'svg' }, {})
  assert.equal(failed.error.code, 'stale_revision')
  assert.equal(failed.result, undefined)
})

test('screenshots pin the selection and forward the requested crop and size', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['icon'] }),
    'preview.capture': request => ({ format: 'futureox.design-preview.v1', parameters: request.params }),
  })
  const shot = ok(await api.callTool('get_screenshot', { maxDimension: 512, contentsOnly: false, enableBase64Response: false }, {}))
  assert.equal(shot.result.inlineImage, false)
  assert.deepEqual(calls.at(-1).params, { format: 'png', maxDimension: 512, contentsOnly: false, pageId: 'page-1', nodeIds: ['icon'] })
  assert.equal(calls.at(-1).expectedRevision, 4)
  for (const args of [{ maxDimension: 0 }, { maxDimension: Infinity }, { contentsOnly: 'true' }, { enableBase64Response: 1 }])
    assert.equal((await api.callTool('get_screenshot', args, {})).error.code, 'invalid_params')
  assert.equal(calls.length, 2)
})

test('get_variable_defs keeps selection bindings and their transitive aliases at one revision', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ ids: ['label'] }),
    'node.get': () => ({ node: { bindings: { fill: 'brand' }, styleRefs: { text: 'body' } } }),
    'variable.list': () => [
      { id: 'brand', values: { Light: { alias: 'palette' }, Dark: { alias: 'dark' } } },
      { id: 'palette', values: { Light: { alias: 'literal' } } },
      { id: 'literal', values: { Light: '#112233' } },
      { id: 'dark', values: { Dark: '#332211' } },
      { id: 'gap', values: { Light: 12 } },
    ],
    'style.list': () => [{ id: 'body', name: 'Body' }, { id: 'other', name: 'Other' }],
  })
  const defs = ok(await api.callTool('get_variable_defs', {}, {}))
  assert.deepEqual(defs.result.variables.map(item => item.id), ['brand', 'palette', 'literal', 'dark'])
  assert.deepEqual(defs.result.styles.map(item => item.id), ['body'])
  assert.deepEqual(defs.result.libraries, [])
  assert.ok(calls.slice(1).every(call => call.documentId === 'doc-1' && call.session === 3 && call.expectedRevision === 4))
  const explicit = ok(await api.callTool('get_variable_defs', { nodeId: 'label' }, {}))
  assert.deepEqual(explicit.result, defs.result)
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
  assert.deepEqual(api.listTools().map(tool => tool.name), ['get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets',
    ...READ_DESKTOP_TOOL_NAMES,
    ...FIGMA_COMPATIBILITY_TOOLS.map(entry => entry.name),
    ...READ_REMOTE_TOOL_NAMES])
  const write = await api.callTool('use_figma', { description: 'Edit', operations: [{ op: 'delete', nodeId: 'a' }] }, {})
  const open = await api.callTool('open_document', { rootHandle: 'root', documentHandle: 'doc', mutationId: 'open-1' }, {})
  assert.equal(write.error.code, 'read_only')
  assert.equal(open.error.code, 'read_only')
  assert.equal(calls.length, 0)
})

test('open_document reports a missing workspace grant and otherwise forwards handles', async () => {
  const missing = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.open') })
  assert.equal(missing.api.listTools().some(tool => tool.name === 'use_figma'), true)
  assert.equal(missing.api.listTools().some(tool => tool.name === 'open_document'), false)
  const unavailable = await missing.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {})
  assert.equal(unavailable.error.code, 'open_unavailable')
  assert.equal(missing.calls.length, 0)
  const present = facade({
    'document.get': () => ({ revision: 5 }),
    'workspace.open': request => ({ handle: request.params.documentHandle, revision: 5 }),
  })
  assert.equal(present.api.listTools().some(tool => tool.name === 'open_document'), true)
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
