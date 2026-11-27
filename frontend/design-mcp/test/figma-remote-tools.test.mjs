import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_TOOLS, FigmaFacade } from '../src/figma-facade.mjs'
import { REMOTE_FIGMA_TOOL_NAMES, REMOTE_FIGMA_TOOLS, remoteToolArgumentsProblem } from '../src/figma-remote-tools.mjs'

const METHODS = [
  'document.get', 'page.list', 'node.find', 'node.get', 'selection.get', 'context.get', 'code.export',
  'preview.capture', 'variable.list', 'style.list', 'vector.export', 'batch.apply', 'workspace.open',
  'workspace.importCopy', 'collection.list', 'review.list', 'svg.import', 'node.create',
]

function facade(handlers, { scope = 'write', methods = METHODS } = {}) {
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
      execute, scope,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }
const pngDataUrl = (width, height) => {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

test('all remote catalog tools are listed with the Figma-shaped names and schemas', () => {
  const { api } = facade({})
  const tools = new Map(api.listTools().map(entry => [entry.name, entry]))
  for (const name of REMOTE_FIGMA_TOOL_NAMES) assert.ok(tools.has(name), name)
  assert.equal(REMOTE_FIGMA_TOOLS.length, 23)
  assert.equal(new Set(FIGMA_MCP_TOOLS.map(entry => entry.name)).size, FIGMA_MCP_TOOLS.length)
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'export_video' && gap.status === 'unsupported'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'get_comments' && gap.status === 'local'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'generative_plugins'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'shaders'))
  const create = tools.get('create_new_file')
  assert.deepEqual(create.inputSchema.required, ['editorType', 'fileName', 'planKey'])
  assert.deepEqual(create.inputSchema.properties.editorType.enum, ['design', 'figjam', 'slides', 'figmake'])
  assert.equal(create.inputSchema.properties.fileName.maxLength, 200)
  assert.equal(create.annotations.readOnlyHint, false)
  const comments = tools.get('get_comments')
  assert.deepEqual(comments.inputSchema.required, ['fileKey'])
  assert.equal(comments.inputSchema.properties.limit.maximum, 100)
  const search = tools.get('search_design_system')
  assert.deepEqual(search.inputSchema.required, ['fileKey', 'queries'])
  assert.deepEqual(search.inputSchema.properties.queries.items.properties.entity.enum, ['component', 'variable', 'style'])
  const context = tools.get('get_context_for_code_connect')
  assert.deepEqual(context.inputSchema.required, ['fileKey', 'nodeId'])
  const video = tools.get('export_video')
  assert.equal(video.inputSchema.properties.fps.minimum, 5)
  assert.equal(video.inputSchema.properties.fps.maximum, 60)
  assert.deepEqual(video.inputSchema.properties.quality.enum, ['low', 'medium', 'high'])
  assert.deepEqual(video.inputSchema.properties.constraint.properties.type.enum, ['SCALE', 'WIDTH', 'HEIGHT'])
  assert.equal(video.inputSchema.properties.ttlSeconds.minimum, 30)
  assert.equal(video.inputSchema.properties.ttlSeconds.maximum, 604800)
  const upload = tools.get('upload_assets')
  assert.equal(upload.inputSchema.properties.assets.maxItems, 60)
  assert.equal(upload.inputSchema.properties.assets.items.properties.dataUrl.maxLength, 14000000)
  const illustration = tools.get('generate_vector_illustration')
  assert.equal(illustration.inputSchema.properties.width.minimum, 16)
  assert.equal(illustration.inputSchema.properties.width.maximum, 2048)
  assert.deepEqual(illustration.inputSchema.properties.kind.enum, ['icon', 'illustration'])
  const plugin = tools.get('update_generative_plugin')
  assert.deepEqual(plugin.inputSchema.properties.files.items.properties.path.enum, ['code.ts', 'ui.html'])
  assert.deepEqual(plugin.inputSchema.required, ['id', 'commitMessage'])
  const shader = tools.get('update_shader')
  assert.deepEqual(shader.inputSchema.properties.files.items.properties.path.enum, ['main.ts'])
  assert.deepEqual(shader.inputSchema.required, ['id', 'kind', 'commitMessage'])
  const shaderCreate = tools.get('create_shader')
  assert.deepEqual(shaderCreate.inputSchema.required, ['name', 'description', 'planKey', 'kind'])
})

test('every remote tool rejects unknown and malformed arguments before any backend call', () => {
  const { api, calls } = facade({})
  assert.equal(remoteToolArgumentsProblem('export_video', { fileKey: 'f', fps: 61 }), 'fps must be at most 60')
  assert.equal(remoteToolArgumentsProblem('export_video', { fileKey: 'f', quality: 'ultra' }), 'quality must be one of low, medium, high')
  assert.equal(remoteToolArgumentsProblem('get_generative_plugin', { id: 'p', version: 'abc' }), 'version must be at least 40 characters')
  assert.equal(remoteToolArgumentsProblem('get_generative_plugin', { id: 'p', version: 'z'.repeat(40) }), 'version has an invalid format')
  assert.equal(remoteToolArgumentsProblem('update_shader', { id: 's', kind: 'solid', commitMessage: 'm' }), 'kind must be one of effect, fill')
  assert.equal(remoteToolArgumentsProblem('search_design_system', { fileKey: 'f', queries: [{ entity: 'component', query: '' }] }), 'queries[0].query must be at least 1 characters')
  assert.equal(remoteToolArgumentsProblem('create_new_file', { editorType: 'design', fileName: 'F' }), 'planKey is required')
  assert.equal(remoteToolArgumentsProblem('whoami', { extra: 1 }), 'Unknown arguments: extra')
  return (async () => {
    assert.equal((await api.callTool('whoami', { extra: 1 }, {})).error.code, 'invalid_params')
    assert.equal((await api.callTool('create_new_file', { editorType: 'design', fileName: 'F' }, {})).error.code, 'invalid_params')
    assert.equal(calls.length, 0)
  })()
})

test('read scope lists the read compat tools, hides remote writes, and refuses direct write calls', async () => {
  const { api, calls } = facade({}, { scope: 'read' })
  const names = api.listTools().map(entry => entry.name)
  for (const name of ['whoami', 'get_comments', 'get_libraries', 'search_design_system', 'get_context_for_code_connect', 'export_video', 'list_generative_plugins', 'get_generative_plugin', 'list_shaders', 'get_shader', 'list_file_shaders'])
    assert.ok(names.includes(name), name)
  for (const name of ['create_new_file', 'upload_assets', 'generate_figma_design', 'generate_diagram', 'generate_image', 'generate_vector_illustration', 'html_to_figma', 'send_code_to_figma', 'create_generative_plugin', 'update_generative_plugin', 'create_shader', 'update_shader'])
    assert.equal(names.includes(name), false, name)
  assert.equal((await api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0', rootHandle: 'root' }, {})).error.code, 'read_only')
  assert.equal((await api.callTool('upload_assets', { fileKey: 'f' }, {})).error.code, 'read_only')
  assert.equal((await api.callTool('generate_image', { prompt: 'cat' }, {})).error.code, 'read_only')
  assert.equal((await api.callTool('update_shader', { id: 's', kind: 'effect', commitMessage: 'm' }, {})).error.code, 'read_only')
  assert.equal(calls.length, 0)
})

test('whoami returns a local application identity, not a Figma account', async () => {
  const { api, calls } = facade({ 'document.get': () => ({ name: 'Local board' }) })
  const response = ok(await api.callTool('whoami', {}, {}))
  assert.equal(response.result.format, 'futureox.local-identity.v1')
  assert.equal(response.result.handle, 'futureox-local')
  assert.equal(response.result.email, null)
  assert.equal(response.result.seat, 'owner')
  assert.deepEqual(response.result.plans.map(plan => plan.key), ['local::0'])
  assert.equal(response.result.document.name, 'Local board')
  assert.match(response.result.note, /not a Figma account/)
  assert.deepEqual(calls.map(call => call.method), ['document.get'])
})

test('whoami still answers when the session has no document read', async () => {
  const { api } = facade({}, { methods: [] })
  const response = ok(await api.callTool('whoami', {}, {}))
  assert.equal(response.result.email, null)
  assert.equal(response.result.document, null)
})

test('create_new_file saves a blank local design through workspace.importCopy', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'workspace.importCopy': request => ({ documentHandle: 'handle-new', name: 'Homepage', storageRevision: 1, mutationId: request.params.mutationId }),
  })
  const response = ok(await api.callTool('create_new_file', {
    editorType: 'design', fileName: 'Homepage', planKey: 'local::0', rootHandle: 'root-1', mutationId: 'new-file-1',
  }, {}))
  assert.equal(response.result.documentHandle, 'handle-new')
  assert.equal(response.result.opened, false)
  assert.equal(response.result.editorType, 'design')
  assert.match(response.result.note, /No Figma cloud file/)
  const importCall = calls.find(call => call.method === 'workspace.importCopy')
  assert.equal(importCall.params.rootHandle, 'root-1')
  assert.equal(importCall.params.format, 'native-json')
  assert.equal(importCall.params.mutationId, 'new-file-1')
  assert.equal(importCall.expectedRevision, 4)
  const document = JSON.parse(importCall.params.content)
  assert.equal(document.name, 'Homepage')
  assert.equal(document.nodes && Object.keys(document.nodes).length, 0)
  assert.equal(document.pages.length, 1)
  assert.deepEqual(document.pages[0].children, [])
})

test('create_new_file refuses non-design editor types and a missing workspace grant', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'workspace.importCopy': () => ({ documentHandle: 'never' }),
  })
  const figjam = await api.callTool('create_new_file', { editorType: 'figjam', fileName: 'Board', planKey: 'local::0', rootHandle: 'root-1' }, {})
  assert.equal(figjam.error.code, 'unsupported_editor_type')
  const slides = await api.callTool('create_new_file', { editorType: 'slides', fileName: 'Deck', planKey: 'local::0', rootHandle: 'root-1' }, {})
  assert.equal(slides.error.code, 'unsupported_editor_type')
  const grant = await api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0' }, {})
  assert.equal(grant.error.code, 'workspace_grant_required')
  assert.equal(calls.length, 0)
  const unavailable = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.importCopy') })
  const missing = await unavailable.api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0', rootHandle: 'root-1' }, {})
  assert.equal(missing.error.code, 'create_file_unavailable')
  const readOnly = facade({}, { scope: 'read' })
  const denied = await readOnly.api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0', rootHandle: 'root-1' }, {})
  assert.equal(denied.error.code, 'read_only')
})

test('get_comments maps local reviews to comment threads with pagination', async () => {
  const review = {
    id: 'review-1', pageId: 'page-1', nodeId: 'card', nextOffset: null,
    position: { x: 10, y: 20 }, kind: 'comment', resolved: false,
    messages: [
      { id: 'm1', author: 'Automation', text: 'Check spacing', createdAt: 100 },
      { id: 'm2', author: 'Automation', text: 'Fixed', createdAt: 200 },
    ],
  }
  const { api } = facade({
    'review.list': request => ({ items: [review], total: 1, nextOffset: null, offset: request.params.offset, limit: request.params.limit }),
  })
  const response = ok(await api.callTool('get_comments', { fileKey: 'figma', pageId: 'page-1' }, {}))
  assert.equal(response.result.format, 'futureox.local-comments.v1')
  assert.equal(response.result.total, 1)
  assert.equal(response.result.nextOffset, null)
  const comment = response.result.comments[0]
  assert.equal(comment.id, 'review-1')
  assert.equal(comment.message, 'Check spacing')
  assert.equal(comment.nodeId, 'card')
  assert.deepEqual(comment.position, { x: 10, y: 20 })
  assert.deepEqual(comment.replies.map(reply => reply.message), ['Fixed'])
  assert.match(response.result.note, /No Figma feedback/)
})

test('get_comments applies resolved and node filters across bounded local reviews', async () => {
  const reviews = [
    { id: 'a', pageId: 'page-1', position: { x: 0, y: 0 }, kind: 'comment', resolved: false, messages: [{ id: '1', author: 'A', text: 'a', createdAt: 1 }] },
    { id: 'b', pageId: 'page-1', nodeId: 'card', position: { x: 0, y: 0 }, kind: 'comment', resolved: true, messages: [{ id: '2', author: 'A', text: 'b', createdAt: 2 }] },
    { id: 'c', pageId: 'page-1', position: { x: 0, y: 0 }, kind: 'annotation', resolved: false, messages: [{ id: '3', author: 'A', text: 'c', createdAt: 3 }] },
  ]
  const { api } = facade({
    'review.list': request => {
      const start = request.params.offset
      return { items: reviews.slice(start, start + request.params.limit), total: reviews.length, nextOffset: start + request.params.limit < reviews.length ? start + request.params.limit : null }
    },
  })
  const resolved = ok(await api.callTool('get_comments', { fileKey: 'f', resolved: true }, {}))
  assert.deepEqual(resolved.result.comments.map(comment => comment.id), ['b'])
  assert.equal(resolved.result.total, 1)
  assert.equal(resolved.result.resolvedFilterApplied, true)
  const node = ok(await api.callTool('get_comments', { fileKey: 'f', nodeId: 'card' }, {}))
  assert.deepEqual(node.result.comments.map(comment => comment.id), ['b'])
  const thread = ok(await api.callTool('get_comments', { fileKey: 'f', threadId: 'c' }, {}))
  assert.deepEqual(thread.result.comments.map(comment => comment.kind), ['annotation'])
  const unsupported = await api.callTool('get_comments', { fileKey: 'f', author: 'Someone' }, {})
  assert.equal(unsupported.error.code, 'unsupported_filter')
  assert.equal((await api.callTool('get_comments', { fileKey: 'f', limit: 101 }, {})).error.code, 'invalid_params')
  const unavailable = facade({}, { methods: METHODS.filter(name => name !== 'review.list') }).api
  assert.equal((await unavailable.callTool('get_comments', { fileKey: 'f' }, {})).error.code, 'comments_unavailable')
})

test('get_libraries maps local collections, variables, and styles to one local library', async () => {
  const { api, calls } = facade({
    'document.get': () => ({ name: 'Design system' }),
    'collection.list': () => [{ id: 'theme', name: 'Theme', modes: ['Light', 'Dark'], defaultMode: 'Light', activeMode: 'Light' }],
    'variable.list': () => [{ id: 'brand', name: 'Brand', collection: 'theme', kind: 'color', values: { Light: '#ff0000', Dark: '#880000' } }, { id: 'gap', name: 'Gap', collection: 'theme', kind: 'number', values: { Light: 4, Dark: 8 } }],
    'style.list': () => [{ id: 'body', name: 'Body', kind: 'text' }],
  })
  const response = ok(await api.callTool('get_libraries', { fileKey: 'figma' }, {}))
  assert.equal(response.result.format, 'futureox.local-libraries.v1')
  assert.equal(response.result.total, 1)
  assert.equal(response.result.nextOffset, null)
  const library = response.result.libraries[0]
  assert.equal(library.key, 'local-document')
  assert.equal(library.name, 'Design system')
  assert.equal(library.variableCount, 2)
  assert.equal(library.styleCount, 1)
  assert.deepEqual(library.collections[0].modes, ['Light', 'Dark'])
  assert.ok(calls.every(call => call.method === 'document.get' || call.expectedRevision === 4))
  const beyond = ok(await api.callTool('get_libraries', { fileKey: 'figma', offset: 1 }, {}))
  assert.deepEqual(beyond.result.libraries, [])
  assert.equal(beyond.result.total, 1)
})

test('search_design_system answers queries in order and reports component queries honestly', async () => {
  const { api } = facade({
    'document.get': () => ({ name: 'Doc' }),
    'variable.list': () => [{ id: 'brand', name: 'Brand color', collection: 'theme', kind: 'color', values: { Light: '#ff0000' } }, { id: 'gap', name: 'Gap', collection: 'theme', kind: 'number', values: { Light: 4 } }],
    'style.list': () => [{ id: 'body', name: 'Body text', kind: 'text' }, { id: 'head', name: 'Heading', kind: 'text' }],
  })
  const response = ok(await api.callTool('search_design_system', {
    fileKey: 'figma', includeLibraryKeys: true,
    queries: [
      { entity: 'variable', query: 'brand' },
      { entity: 'style', query: 'body' },
      { entity: 'component', query: 'button' },
    ],
  }, {}))
  assert.deepEqual(response.result.results.map(entry => entry.entity), ['variable', 'style', 'component'])
  assert.deepEqual(response.result.results[0].matches.map(match => match.id), ['brand'])
  assert.equal(response.result.results[0].matches[0].libraryKey, 'local-document')
  assert.deepEqual(response.result.results[1].matches.map(match => match.id), ['body'])
  assert.equal(response.result.results[2].status, 'unsupported')
  assert.deepEqual(response.result.results[2].matches, [])
  assert.match(response.result.note, /Code Connect mapping store/)
})

test('get_context_for_code_connect returns local component metadata without Code Connect templates', async () => {
  const node = {
    id: 'button', name: 'Button', kind: 'frame', width: 120, height: 40, childCount: 2, componentSet: false, componentKey: 'key-1',
    component: {
      variants: { Size: 'Large' },
      properties: { label: { name: 'Label', kind: 'text', targetKey: 'label', defaultValue: 'Go' } },
      slots: { icon: { name: 'Icon', targetKey: 'icon' } },
    },
  }
  const { api } = facade({
    'node.get': () => ({ node, ...node }),
    'node.find': () => ({ nodes: [node, { id: 'text-1', name: 'Label', kind: 'text', parentId: 'button' }], nextCursor: null }),
  })
  const response = ok(await api.callTool('get_context_for_code_connect', { fileKey: 'figma', nodeId: 'button' }, {}))
  assert.equal(response.result.format, 'futureox.component-context.v1')
  assert.equal(response.result.isComponent, true)
  assert.deepEqual(response.result.variants, { Size: 'Large' })
  assert.equal(response.result.properties.label.kind, 'text')
  assert.equal(response.result.properties.label.defaultValue, 'Go')
  assert.deepEqual(response.result.slots.icon, { name: 'Icon', targetKey: 'icon' })
  assert.deepEqual(response.result.descendants.map(entry => entry.id), ['text-1'])
  assert.equal(response.result.codeConnect.available, false)
  assert.deepEqual(response.result.codeConnect.mappings, [])
  const plain = facade({ 'node.get': () => ({ node: { id: 'rect', name: 'Rect', kind: 'rectangle' }, id: 'rect', name: 'Rect', kind: 'rectangle' }), 'node.find': () => ({ nodes: [], nextCursor: null }) }).api
  const plainResponse = ok(await plain.callTool('get_context_for_code_connect', { fileKey: 'f', nodeId: 'rect' }, {}))
  assert.equal(plainResponse.result.isComponent, false)
})

test('export_video validates the documented settings and refuses remote rendering', async () => {
  const { api, calls } = facade({})
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', fps: 61 }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', jobId: 'j' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', constraint: { type: 'SCALE', value: 11 } }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', constraint: { type: 'WIDTH', value: 4097 } }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', ttlSeconds: 10 }, {})).error.code, 'invalid_params')
  const start = await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', fps: 30, quality: 'high', constraint: { type: 'SCALE', value: 2 }, ttlSeconds: 3600 }, {})
  assert.equal(start.ok, false)
  assert.equal(start.error.code, 'unsupported_remote_capability')
  assert.match(start.error.message, /no job was created/)
  const poll = await api.callTool('export_video', { fileKey: 'f', jobId: 'job-1' }, {})
  assert.equal(poll.error.code, 'unsupported_remote_capability')
  assert.equal(calls.length, 0)
})

test('upload_assets imports inline SVG and raster assets and rejects fabricated upload slots', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const png = pngDataUrl(2, 3)
  const { api, calls } = facade({
    'document.get': () => ({}),
    'svg.import': request => ({ rootIds: ['svg-root'], nodeIdMap: {}, warnings: ['foreign SVG approximation'], format: 'futureox.design-import.v1', content: request.params.content }),
    'node.create': request => ({ id: 'image-node', patch: request.params.patch }),
  })
  const noPayload = await api.callTool('upload_assets', { fileKey: 'f' }, {})
  assert.equal(noPayload.error.code, 'inline_assets_required')
  assert.equal(calls.length, 0)
  const response = ok(await api.callTool('upload_assets', {
    fileKey: 'f', count: 2, currentPageId: 'page-1', scaleMode: 'FILL',
    assets: [
      { name: 'icon', mimeType: 'image/svg+xml', content: svg },
      { name: 'photo', mimeType: 'image/png', dataUrl: png },
    ],
  }, {}))
  assert.equal(response.result.imported, 2)
  assert.equal(response.result.assets[0].kind, 'svg')
  assert.equal(response.result.assets[0].nodeId, 'svg-root')
  assert.equal(response.result.assets[1].kind, 'raster')
  assert.equal(response.result.assets[1].width, 2)
  assert.equal(response.result.assets[1].height, 3)
  assert.equal(response.result.scaleModeIgnored, true)
  const svgCall = calls.find(call => call.method === 'svg.import')
  assert.equal(svgCall.params.content, svg)
  assert.equal(svgCall.params.pageId, 'page-1')
  const createCall = calls.find(call => call.method === 'node.create')
  assert.equal(createCall.params.kind, 'rectangle')
  assert.equal(createCall.params.parentId, 'page-1')
  assert.equal(createCall.params.width, 2)
  assert.equal(createCall.params.height, 3)
  assert.equal(createCall.params.patch.fills[0].kind, 'image')
  assert.equal(createCall.params.patch.fills[0].image, png)
  const mismatch = await api.callTool('upload_assets', { fileKey: 'f', count: 1, assets: [{ content: svg, mimeType: 'image/svg+xml' }, { content: svg, mimeType: 'image/svg+xml' }] }, {})
  assert.equal(mismatch.error.code, 'invalid_params')
  const tooMany = await api.callTool('upload_assets', { fileKey: 'f', assets: Array.from({ length: 61 }, () => ({ content: svg, mimeType: 'image/svg+xml' })) }, {})
  assert.equal(tooMany.error.code, 'invalid_params')
  const tooBig = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ content: 'x', dataUrl: png }] }, {})
  assert.equal(tooBig.error.code, 'invalid_params')
  const readOnly = facade({}, { scope: 'read' }).api
  assert.equal((await readOnly.callTool('upload_assets', { fileKey: 'f' }, {})).error.code, 'read_only')
})

test('remote-only generation, capture, Make, plugin, and shader tools return a typed unsupported error', async () => {
  const { api, calls } = facade({})
  const callsToMake = [
    ['generate_figma_design', { fileKey: 'f', captureId: 'c' }],
    ['generate_diagram', { mermaidSyntax: 'flowchart TD; A-->B', name: 'Flow' }],
    ['generate_image', { prompt: 'a cat', width: 512, height: 512, planKey: 'local::0' }],
    ['generate_vector_illustration', { fileKey: 'f', prompt: 'a fox', kind: 'icon', width: 64, height: 64 }],
    ['html_to_figma', { fileKey: 'f', html: '<html><body>Hi</body></html>' }],
    ['send_code_to_figma', { fileKey: 'f', pageId: 'page-1' }],
    ['list_generative_plugins', {}],
    ['get_generative_plugin', { id: 'plugin-1', version: 'a'.repeat(40), includeSource: true }],
    ['create_generative_plugin', { name: 'Renamer', description: 'Renames layers', planKey: 'local::0' }],
    ['update_generative_plugin', { id: 'plugin-1', commitMessage: 'rename', files: [{ path: 'code.ts', content: 'figma.closePlugin()' }] }],
    ['list_shaders', {}],
    ['get_shader', { id: 'shader-1', includeSource: true }],
    ['list_file_shaders', { fileKey: 'f' }],
    ['create_shader', { name: 'Contour', description: 'Fill', planKey: 'local::0', kind: 'fill' }],
    ['update_shader', { id: 'shader-1', kind: 'effect', commitMessage: 'tune', files: [{ path: 'main.ts', content: 'export default 1' }], metadata: { isAnimated: true, usesMouse: false } }],
  ]
  for (const [name, args] of callsToMake) {
    const response = await api.callTool(name, args, {})
    assert.equal(response.ok, false, name)
    assert.equal(response.error.code, 'unsupported_remote_capability', `${name}: ${response.error.code}`)
  }
  assert.equal(calls.length, 0)
  assert.equal((await api.callTool('get_generative_plugin', { id: 'p', version: 'not-a-sha' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('update_shader', { id: 's', kind: 'solid', commitMessage: 'm' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('create_shader', { name: 'S', description: 'D', planKey: 'local::0', kind: 'shadow' }, {})).error.code, 'invalid_params')
  const readOnly = facade({}, { scope: 'read' }).api
  assert.equal((await readOnly.callTool('generate_image', { prompt: 'cat' }, {})).error.code, 'read_only')
  assert.equal((await readOnly.callTool('list_generative_plugins', {}, {})).error.code, 'unsupported_remote_capability')
})

test('the MCP server advertises and calls the new catalog over the Figma stdio session', async t => {
  const { api } = facade({ 'document.get': () => ({ name: 'Session doc' }) })
  const input = new PassThrough(), output = new PassThrough()
  let bytes = ''
  const messages = []
  output.on('data', chunk => { bytes += chunk; let index; while ((index = bytes.indexOf('\n')) !== -1) { messages.push(JSON.parse(bytes.slice(0, index))); bytes = bytes.slice(index + 1) } })
  const server = new DesignMcpServer({ input, output, diagnostics: new PassThrough(), backend: api }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy() })
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  const wait = async count => { const end = Date.now() + 1000; while (messages.length < count) { if (Date.now() > end) throw new Error(`expected ${count}`); await delay(2) }; return messages.at(-1) }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'figma-client', version: '1' } } })
  await wait(1)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const listed = await wait(2)
  assert.equal(listed.result.tools.length, FIGMA_MCP_TOOLS.length)
  const names = listed.result.tools.map(entry => entry.name)
  for (const name of ['whoami', 'create_new_file', 'get_comments', 'get_libraries', 'search_design_system', 'get_context_for_code_connect', 'export_video', 'upload_assets', 'generate_figma_design', 'generate_diagram', 'generate_image', 'generate_vector_illustration', 'html_to_figma', 'send_code_to_figma', 'list_generative_plugins', 'get_generative_plugin', 'create_generative_plugin', 'update_generative_plugin', 'list_shaders', 'get_shader', 'list_file_shaders', 'create_shader', 'update_shader']) assert.ok(names.includes(name), name)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
  const called = await wait(3)
  assert.equal(called.result.isError, false)
  assert.equal(called.result.structuredContent.result.email, null)
  assert.match(called.result.content[0].text, /local-identity/)
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'export_video', arguments: { fileKey: 'f', nodeId: 'n' } } })
  const refused = await wait(4)
  assert.equal(refused.result.isError, true)
  assert.equal(refused.result.structuredContent.error.code, 'unsupported_remote_capability')
})