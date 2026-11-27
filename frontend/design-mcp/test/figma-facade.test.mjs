import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_INSTRUCTIONS, FIGMA_MCP_TOOLS, FigmaFacade, metadataXml, registerFigmaPluginBridge, validateFigmaOperation } from '../src/figma-facade.mjs'

const METHODS = ['document.get', 'page.list', 'node.find', 'node.get', 'selection.get', 'context.get', 'code.export', 'preview.capture', 'variable.list', 'style.list', 'vector.export', 'batch.apply', 'workspace.open']

function facade(handlers, { scope = 'write', pluginBridge, methods = METHODS, extensions = false } = {}) {
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
      execute, scope, pluginBridge, extensions,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' }, mutates: name === 'batch.apply' || name === 'workspace.open' })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }

test('advertised tools match the Figma-shaped subset and do not invent registry aliases', () => {
  const names = FIGMA_MCP_TOOLS.map(tool => tool.name)
  for (const name of ['get_metadata', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets', 'use_figma']) assert.ok(names.includes(name), name)
  assert.equal(FIGMA_MCP_TOOLS.find(tool => tool.name === 'use_figma').inputSchema.required.join(','), 'description')
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'whoami' && gap.status === 'absent'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'use_figma_plugin_javascript' && /unsupported_remote_capability/.test(gap.detail)))
  assert.equal(validateFigmaOperation({ op: 'create', kind: 'button' }), 'create kind must be one of slice, frame, section, group, rectangle, ellipse, polygon, star, line, vector, text')
})

test('get_selection and open_document are Futureox extension tools hidden by default', async () => {
  const handlers = {
    'selection.get': () => ({ pageId: 'page-1', ids: [] }),
    'document.get': () => ({ revision: 4 }),
    'workspace.open': () => ({ handle: 'saved', revision: 4 }),
  }
  const { api } = facade(handlers)
  assert.equal(api.listTools().some(tool => tool.name === 'get_selection'), false)
  assert.equal(api.listTools().some(tool => tool.name === 'open_document'), false)
  assert.equal((await api.callTool('get_selection', {}, {})).error.code, 'unknown_tool')
  const extended = facade(handlers, { extensions: true }).api
  assert.equal(extended.listTools().some(tool => tool.name === 'get_selection'), true)
  assert.equal(extended.listTools().some(tool => tool.name === 'open_document'), true)
  ok(await extended.callTool('get_selection', {}, {}))
})

test('desktop Code Connect, FigJam and shader tools are visible with a documented typed error', async () => {
  const { api, calls } = facade({})
  const names = api.listTools().map(tool => tool.name)
  for (const name of ['get_code_connect_map', 'get_code_connect_suggestions', 'get_figjam', 'get_motion_context', 'get_shader', 'list_shaders', 'add_code_connect_map', 'send_code_connect_mappings']) assert.ok(names.includes(name), name)
  const read = await api.callTool('get_code_connect_map', { fileKey: 'figma-file' }, {})
  assert.equal(read.error.code, 'unsupported_remote_capability')
  assert.equal((await api.callTool('get_figjam', { fileKey: 'figma-file' }, {})).error.code, 'unsupported_remote_capability')
  assert.equal((await api.callTool('get_shader', { id: 'shader-1' }, {})).error.code, 'unsupported_remote_capability')
  assert.equal((await api.callTool('list_shaders', {}, {})).error.code, 'unsupported_remote_capability')
  const added = await api.callTool('add_code_connect_map', { nodeId: 'node-1', fileKey: 'figma-file', source: 'src/Button.tsx', componentName: 'Button', label: 'React' }, {})
  assert.equal(added.error.code, 'unsupported_remote_capability')
  assert.deepEqual(calls, [])
  const readOnly = facade({}, { scope: 'read' }).api
  assert.equal(readOnly.listTools().some(tool => tool.name === 'add_code_connect_map'), false)
  assert.equal((await readOnly.callTool('add_code_connect_map', { nodeId: 'n', fileKey: 'f', source: 's', componentName: 'c', label: 'l' }, {})).error.code, 'read_only')
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

test('get_metadata returns the page list for a Figma cloud node id instead of forwarding it', async () => {
  const { api, calls } = facade({
    'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }),
  })
  const result = ok(await api.callTool('get_metadata', { nodeId: '1:2', fileKey: 'figma-file' }, {}))
  assert.equal(result.result.scope, 'pages')
  assert.equal(result.result.nodeIdIgnored, true)
  assert.deepEqual(result.result.pages, [{ id: 'page-1', name: 'Cover' }])
  assert.match(result.result.modelText, /<page id="page-1"/)
  assert.equal(calls.some(call => call.method === 'node.find'), false)
})

test('Fig-related node tools reject Figma cloud node ids with a typed error', async () => {
  const { api } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: [] }),
    'node.find': () => ({ nodes: [] }),
  })
  for (const [tool, args] of [
    ['get_design_context', { nodeId: '1:2', fileKey: 'figma-file' }],
    ['get_screenshot', { nodeId: '1:2', fileKey: 'figma-file' }],
    ['get_variable_defs', { nodeId: '1:2', fileKey: 'figma-file' }],
    ['download_assets', { nodeIds: ['1:2'], fileKey: 'figma-file' }],
  ]) {
    const response = await api.callTool(tool, args, {})
    assert.equal(response.error.code, 'unsupported_figma_node_id', tool)
  }
})

test('get_design_context accepts the Figma optional switches and reports local fidelity', async () => {
  const { api } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['card'] }),
    'context.get': () => ({ nodes: [{ id: 'card', name: 'Card', kind: 'frame' }] }),
    'code.export': () => ({ html: '<main></main>', css: '.card{}', fidelity: 'approximate', warnings: [] }),
  })
  const response = ok(await api.callTool('get_design_context', {
    nodeId: 'card', fileKey: 'figma-file', disableCodeConnect: true, excludeScreenshot: true, forceCode: true, clientFrameworks: ['react'],
  }, {}))
  assert.equal(response.result.format, 'futureox.design-code.v1')
  assert.equal(response.result.framework, 'futureox-html-css')
  assert.equal(response.result.react, false)
  assert.equal(response.result.tailwind, false)
  assert.equal(response.result.codeConnect, false)
  assert.equal(response.result.screenshot, false)
  assert.equal(response.result.disableCodeConnect, true)
  assert.equal(response.result.excludeScreenshot, true)
  assert.equal(response.result.forceCode, true)
  for (const key of ['disableCodeConnect', 'excludeScreenshot', 'forceCode']) {
    const invalid = await api.callTool('get_design_context', { nodeId: 'card', [key]: 'yes' }, {})
    assert.equal(invalid.error.code, 'invalid_params', key)
  }
})

test('use_figma uses the connected Figma limits and documents unsupported plugin runtime', async () => {
  const { api, calls } = facade({ 'document.get': () => ({ revision: 8 }) })
  const longDescription = await api.callTool('use_figma', { description: 'x'.repeat(2001), operations: [{ op: 'select', nodeIds: [] }] }, {})
  assert.equal(longDescription.error.code, 'invalid_params')
  const longCode = await api.callTool('use_figma', { description: 'Run', code: 'x'.repeat(50001) }, {})
  assert.equal(longCode.error.code, 'invalid_params')
  const plugin = await api.callTool('use_figma', { description: 'Run', code: 'figma.currentPage.selection' }, {})
  assert.equal(plugin.error.code, 'unsupported_remote_capability')
  assert.equal(calls.length, 0)
})

test('get_selection reads ids and summarizes at most the requested nodes', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['a', 'b'] }),
    'node.get': request => ({ id: request.params.id, name: request.params.id, kind: 'rectangle', width: 12, height: 8, node: { id: request.params.id } }),
  }, { extensions: true })
  const selected = ok(await api.callTool('get_selection', {}, {}))
  assert.deepEqual(selected.result.ids, ['a', 'b'])
  assert.deepEqual(selected.result.nodes.map(node => node.id), ['a', 'b'])
  assert.deepEqual(calls.map(call => call.method), ['selection.get', 'node.get', 'node.get'])
})

test('a Figma cloud sessionId is ignored while a foreign local transport session is rejected', async () => {
  const calls = []
  const api = new FigmaFacade({ scope: 'read', localSessionId: 'desktop-grant-id', methods: [{ name: 'selection.get' }], extensions: true,
    execute: async request => {
      calls.push(request)
      return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: 4,
        result: { ids: [], pageId: 'page-1' } }
    },
  })
  assert.equal((await api.callTool('get_selection', { sessionId: 'another-grant' })).error.code, 'invalid_local_session')
  assert.equal((await api.callTool('get_selection', { sessionId: 3 })).error.code, 'invalid_params')
  assert.deepEqual(calls, [])
  ok(await api.callTool('get_selection', { sessionId: 'desktop-grant-id' }))
  ok(await api.callTool('get_selection', { sessionId: '00000000-0000-4000-8000-000000000000' }))
  assert.deepEqual(calls.map(request => request.params), [{}, {}])
  const other = await api.callTool('get_selection', { sessionId: '11111111-1111-4111-8111-111111111111' }, { localSessionIds: () => ['11111111-1111-4111-8111-111111111111'] })
  assert.equal(other.error.code, 'invalid_local_session')
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

test('download_assets rawImagesOnly reads original embedded fills instead of re-rendering', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'raster.sourceAssets': () => ({ assets: [{ nodeId: 'photo', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }] }),
  }, { methods: [...METHODS, 'raster.sourceAssets'] })
  const raw = ok(await api.callTool('download_assets', { nodeId: 'photo', rawImagesOnly: true }, {}))
  assert.equal(raw.result.delivery, 'mcp-resources')
  assert.equal(raw.result.temporaryUrls, false)
  assert.deepEqual(calls.map(call => call.method), ['document.get', 'raster.sourceAssets'])
  assert.deepEqual(calls.at(-1).params, { nodeIds: ['photo'] })
  const conflict = await api.callTool('download_assets', { nodeId: 'photo', rawImagesOnly: true, defaultFormat: 'png' }, {})
  assert.equal(conflict.error.code, 'invalid_params')
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
  assert.equal(blocked.error.code, 'unsupported_remote_capability')
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
  const names = api.listTools().map(tool => tool.name)
  for (const name of ['get_metadata', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets', 'get_motion_context']) assert.ok(names.includes(name), name)
  for (const name of ['get_selection', 'use_figma', 'open_document', 'add_code_connect_map', 'send_code_connect_mappings']) assert.equal(names.includes(name), false, name)
  const write = await api.callTool('use_figma', { description: 'Edit', operations: [{ op: 'delete', nodeId: 'a' }] }, {})
  const open = await api.callTool('open_document', { rootHandle: 'root', documentHandle: 'doc', mutationId: 'open-1' }, {})
  assert.equal(write.error.code, 'read_only')
  assert.equal(open.error.code, 'unknown_tool')
  assert.equal(calls.length, 0)
})

test('open_document reports a missing workspace grant and otherwise forwards handles', async () => {
  const missing = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.open'), extensions: true })
  assert.equal(missing.api.listTools().some(tool => tool.name === 'use_figma'), true)
  assert.equal(missing.api.listTools().some(tool => tool.name === 'open_document'), false)
  const unavailable = await missing.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {})
  assert.equal(unavailable.error.code, 'open_unavailable')
  assert.equal(missing.calls.length, 0)
  const present = facade({
    'document.get': () => ({ revision: 5 }),
    'workspace.open': request => ({ handle: request.params.documentHandle, revision: 5 }),
  }, { extensions: true })
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
  assert.match(initialized.result.instructions, /unsupported_remote_capability/)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_metadata', arguments: {} } })
  const call = await wait(2)
  assert.equal(call.result.isError, false)
  assert.match(call.result.content[0].text, /^<canvas /)
  assert.equal(call.result.structuredContent.result.modelText, undefined)
})
