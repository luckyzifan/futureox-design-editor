import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_TOOLS, FigmaFacade } from '../src/figma-facade.mjs'
import { FIGMA_COMPATIBILITY_TOOLS } from '../src/figma-weave-tools.mjs'
import {
  FIGMA_REMOTE_DOC, REMOTE_FIGMA_GAPS, REMOTE_FIGMA_TOOL_NAMES, REMOTE_FIGMA_TOOLS,
  UNSUPPORTED_REMOTE_CAPABILITY, remoteToolArgumentsProblem,
} from '../src/figma-remote-tools.mjs'

const METHODS = [
  'document.get', 'page.list', 'node.find', 'node.get', 'selection.get', 'context.get', 'code.export',
  'preview.capture', 'variable.list', 'style.list', 'vector.export', 'batch.apply', 'workspace.open',
  'workspace.importCopy', 'collection.list', 'review.list', 'svg.import', 'node.create', 'component.list', 'component.get',
]

/** Deterministic Design API substitute. Methods named in `mutate` require the
 * current expectedRevision and increment it after a successful commit, which
 * is the real editor contract. Everything else is a read or host operation. */
function facade(handlers = {}, { scope = 'write', methods = METHODS, revision = 4, mutate = [], localSessionId } = {}) {
  const calls = []
  let current = revision
  const increment = new Set(mutate)
  const execute = async request => {
    calls.push(request)
    const handler = handlers[request.method]
    if (!handler) return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: current, error: { code: 'missing', message: request.method } }
    if (increment.has(request.method) && request.expectedRevision !== current)
      return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: current, error: { code: 'revision_conflict', message: `${request.method} expected ${request.expectedRevision}, actual ${current}` } }
    const result = await handler(request)
    if (result?.__fail) return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: current, error: result.__fail }
    if (increment.has(request.method)) current += 1
    return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: current, result }
  }
  return {
    calls,
    get revision() { return current },
    api: new FigmaFacade({
      execute, scope, localSessionId,
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
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'

test('the remote catalog is listed with Figma names, schemas, and dedicated gap rows', () => {
  const { api } = facade()
  const tools = new Map(api.listTools().map(entry => [entry.name, entry]))
  for (const name of REMOTE_FIGMA_TOOL_NAMES) assert.ok(tools.has(name), name)
  assert.equal(REMOTE_FIGMA_TOOLS.length, 23)
  assert.equal(REMOTE_FIGMA_TOOL_NAMES.size, 23)
  assert.equal(FIGMA_MCP_TOOLS.length, 8)
  assert.equal(new Set([...FIGMA_MCP_TOOLS, ...FIGMA_COMPATIBILITY_TOOLS, ...REMOTE_FIGMA_TOOLS].map(entry => entry.name)).size,
    FIGMA_MCP_TOOLS.length + FIGMA_COMPATIBILITY_TOOLS.length + REMOTE_FIGMA_TOOLS.length)
  for (const entry of REMOTE_FIGMA_TOOLS) for (const key of entry.inputSchema.required ?? [])
    assert.ok(entry.inputSchema.properties[key], `${entry.name} requires undeclared ${key}`)
  assert.ok(REMOTE_FIGMA_GAPS.every(gap => ['local', 'unsupported'].includes(gap.status)))
  for (const id of ['whoami', 'create_new_file', 'upload_assets', 'get_comments', 'get_libraries', 'search_design_system', 'get_context_for_code_connect', 'export_video', 'generative_plugins', 'shaders'])
    assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === id), id)
  assert.equal(FIGMA_MCP_GAPS.find(gap => gap.id === 'whoami').status, 'local')
  assert.equal(FIGMA_MCP_GAPS.find(gap => gap.id === 'upload_assets').status, 'local')
  assert.equal(FIGMA_MCP_GAPS.find(gap => gap.id === 'export_video').status, 'unsupported')
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
  assert.deepEqual(tools.get('create_shader').inputSchema.required, ['name', 'description', 'planKey', 'kind'])
  assert.equal(tools.get('get_generative_plugin').inputSchema.properties.version.pattern, '^[0-9a-f]{40}$')
})

test('a read-only session lists only read remote tools and refuses write calls first', async () => {
  const { api, calls } = facade({}, { scope: 'read' })
  const names = api.listTools().map(entry => entry.name)
  for (const name of ['whoami', 'get_comments', 'get_libraries', 'search_design_system', 'get_context_for_code_connect', 'export_video', 'list_generative_plugins', 'get_generative_plugin', 'list_shaders', 'get_shader', 'list_file_shaders'])
    assert.ok(names.includes(name), name)
  for (const name of ['create_new_file', 'upload_assets', 'generate_figma_design', 'generate_diagram', 'generate_image', 'generate_vector_illustration', 'html_to_figma', 'send_code_to_figma', 'create_generative_plugin', 'update_generative_plugin', 'create_shader', 'update_shader'])
    assert.equal(names.includes(name), false, name)
  assert.equal((await api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0', rootHandle: 'root' })).error.code, 'read_only')
  assert.equal((await api.callTool('upload_assets', { fileKey: 'f' })).error.code, 'read_only')
  assert.equal((await api.callTool('generate_image', { prompt: 'cat' })).error.code, 'read_only')
  assert.equal((await api.callTool('update_shader', { id: 's', kind: 'effect', commitMessage: 'm' })).error.code, 'read_only')
  assert.equal(calls.length, 0)
})

test('every remote tool rejects unknown and malformed arguments before any backend call', async () => {
  const { api, calls } = facade()
  assert.equal(remoteToolArgumentsProblem('export_video', { fileKey: 'f', fps: 61 }), 'fps must be at most 60')
  assert.equal(remoteToolArgumentsProblem('export_video', { fileKey: 'f', quality: 'ultra' }), 'quality must be one of low, medium, high')
  assert.equal(remoteToolArgumentsProblem('get_generative_plugin', { id: 'p', version: 'abc' }), 'version must be at least 40 characters')
  assert.equal(remoteToolArgumentsProblem('get_generative_plugin', { id: 'p', version: 'z'.repeat(40) }), 'version has an invalid format')
  assert.equal(remoteToolArgumentsProblem('update_shader', { id: 's', kind: 'solid', commitMessage: 'm' }), 'kind must be one of effect, fill')
  assert.equal(remoteToolArgumentsProblem('search_design_system', { fileKey: 'f', queries: [{ entity: 'component', query: '' }] }), 'queries[0].query must be at least 1 characters')
  assert.equal(remoteToolArgumentsProblem('create_new_file', { editorType: 'design', fileName: 'F' }), 'planKey is required')
  assert.equal(remoteToolArgumentsProblem('whoami', { extra: 1 }), 'Unknown arguments: extra')
  assert.equal(remoteToolArgumentsProblem('upload_assets', { fileKey: 'f', assets: [{ content: SVG, dataUrl: pngDataUrl(1, 1) }] }), null)
  assert.equal((await api.callTool('whoami', { extra: 1 })).error.code, 'invalid_params')
  assert.equal((await api.callTool('create_new_file', { editorType: 'design', fileName: 'F' })).error.code, 'invalid_params')
  assert.equal((await api.callTool('upload_assets', { fileKey: 'f', assets: [] })).error.code, 'invalid_params')
  for (const name of REMOTE_FIGMA_TOOL_NAMES) {
    const response = await api.callTool(name, { extra: 1 })
    assert.equal(response.ok, false, name)
    assert.equal(response.error.code, 'invalid_params', name)
    assert.match(response.error.message, /Unknown arguments: extra/, name)
  }
  assert.equal(calls.length, 0)
})

test('the sessionId assertion is checked before any remote handler runs', async () => {
  const { api, calls } = facade({ 'document.get': () => ({ name: 'Doc' }) }, { methods: ['document.get'] })
  const denied = await api.callTool('whoami', { sessionId: 'another-session' })
  assert.equal(denied.error.code, 'invalid_local_session')
  assert.equal(calls.length, 0)
  const { api: bound, calls: boundCalls } = facade({ 'document.get': () => ({}) }, { methods: ['document.get'], localSessionId: 'desktop-grant-1' })
  for (const name of REMOTE_FIGMA_TOOL_NAMES)
    assert.equal((await bound.callTool(name, { sessionId: 'wrong-grant' })).error.code, 'invalid_local_session', name)
  assert.equal(boundCalls.length, 0)
  const accepted = await bound.callTool('whoami', { sessionId: 'desktop-grant-1' })
  assert.equal(accepted.ok, true)
  assert.deepEqual(boundCalls.map(call => call.method), ['document.get'])
})

test('whoami returns a local application identity, not a Figma account', async () => {
  const { api, calls } = facade({ 'document.get': () => ({ name: 'Local board' }) })
  const response = ok(await api.callTool('whoami', {}))
  assert.equal(response.result.format, 'futureox.local-identity.v1')
  assert.equal(response.result.handle, 'futureox-local')
  assert.equal(response.result.email, null)
  assert.equal(response.result.seat, 'owner')
  assert.deepEqual(response.result.plans.map(plan => plan.key), ['local::0'])
  assert.equal(response.result.document.name, 'Local board')
  assert.match(response.result.note, /not a Figma account/)
  assert.deepEqual(calls.map(call => call.method), ['document.get'])
  const { api: bare } = facade({}, { methods: [] })
  const fallback = ok(await bare.callTool('whoami', {}))
  assert.equal(fallback.result.email, null)
  assert.equal(fallback.result.document, null)
})

test('create_new_file saves a blank local design through workspace.importCopy', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'workspace.importCopy': request => ({ documentHandle: 'handle-new', name: 'Homepage', storageRevision: 1, mutationId: request.params.mutationId }),
  })
  const response = ok(await api.callTool('create_new_file', {
    editorType: 'design', fileName: 'Homepage', planKey: 'local::0', rootHandle: 'root-1', mutationId: 'new-file-1',
  }))
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

test('create_new_file refuses non-design editor types and missing workspace grants', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'workspace.importCopy': () => ({ documentHandle: 'never' }),
  })
  assert.equal((await api.callTool('create_new_file', { editorType: 'figjam', fileName: 'Board', planKey: 'local::0', rootHandle: 'root-1' })).error.code, 'unsupported_editor_type')
  assert.equal((await api.callTool('create_new_file', { editorType: 'slides', fileName: 'Deck', planKey: 'local::0', rootHandle: 'root-1' })).error.code, 'unsupported_editor_type')
  assert.equal((await api.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0' })).error.code, 'workspace_grant_required')
  assert.equal(calls.length, 0)
  const missing = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.importCopy') }).api
  assert.equal((await missing.callTool('create_new_file', { editorType: 'design', fileName: 'Page', planKey: 'local::0', rootHandle: 'root-1' })).error.code, 'create_file_unavailable')
})

test('get_comments maps local reviews to bounded comment threads', async () => {
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
  const response = ok(await api.callTool('get_comments', { fileKey: 'figma', pageId: 'page-1' }))
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

test('get_comments applies resolved, node, and thread filters across bounded local reviews', async () => {
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
  const resolved = ok(await api.callTool('get_comments', { fileKey: 'f', resolved: true }))
  assert.deepEqual(resolved.result.comments.map(comment => comment.id), ['b'])
  assert.equal(resolved.result.total, 1)
  assert.equal(resolved.result.resolvedFilterApplied, true)
  const node = ok(await api.callTool('get_comments', { fileKey: 'f', nodeId: 'card' }))
  assert.deepEqual(node.result.comments.map(comment => comment.id), ['b'])
  const thread = ok(await api.callTool('get_comments', { fileKey: 'f', threadId: 'c' }))
  assert.deepEqual(thread.result.comments.map(comment => comment.kind), ['annotation'])
  assert.equal((await api.callTool('get_comments', { fileKey: 'f', author: 'Someone' })).error.code, 'unsupported_filter')
  assert.equal((await api.callTool('get_comments', { fileKey: 'f', limit: 101 })).error.code, 'invalid_params')
  const unavailable = facade({}, { methods: METHODS.filter(name => name !== 'review.list') }).api
  assert.equal((await unavailable.callTool('get_comments', { fileKey: 'f' })).error.code, 'comments_unavailable')
})

test('get_libraries maps local collections, variables, components, and styles to one library', async () => {
  const { api, calls } = facade({
    'document.get': () => ({ name: 'Design system' }),
    'collection.list': () => [{ id: 'theme', name: 'Theme', modes: ['Light', 'Dark'], defaultMode: 'Light', activeMode: 'Light' }],
    'variable.list': () => [{ id: 'brand', name: 'Brand', collection: 'theme', kind: 'color', values: { Light: '#ff0000', Dark: '#880000' } }, { id: 'gap', name: 'Gap', collection: 'theme', kind: 'number', values: { Light: 4, Dark: 8 } }],
    'component.list': () => [{ id: 'button', name: 'Button', componentSet: false }, { id: 'card', name: 'Card', componentSet: true }],
    'style.list': () => [{ id: 'body', name: 'Body', kind: 'text' }],
  })
  const response = ok(await api.callTool('get_libraries', { fileKey: 'figma' }))
  assert.equal(response.result.format, 'futureox.local-libraries.v1')
  assert.equal(response.result.total, 1)
  assert.equal(response.result.nextOffset, null)
  const library = response.result.libraries[0]
  assert.equal(library.key, 'local-document')
  assert.equal(library.name, 'Design system')
  assert.equal(library.variableCount, 2)
  assert.equal(library.componentCount, 2)
  assert.equal(library.styleCount, 1)
  assert.deepEqual(library.collections[0].modes, ['Light', 'Dark'])
  assert.ok(calls.every(call => call.method === 'document.get' || call.expectedRevision === 4))
  const beyond = ok(await api.callTool('get_libraries', { fileKey: 'figma', offset: 1 }))
  assert.deepEqual(beyond.result.libraries, [])
  assert.equal(beyond.result.total, 1)
})

test('search_design_system answers component, variable, and style queries in order', async () => {
  const { api } = facade({
    'document.get': () => ({ name: 'Doc' }),
    'variable.list': () => [{ id: 'brand', name: 'Brand color', collection: 'theme', kind: 'color', values: { Light: '#ff0000' } }, { id: 'gap', name: 'Gap', collection: 'theme', kind: 'number', values: { Light: 4 } }],
    'style.list': () => [{ id: 'body', name: 'Body text', kind: 'text' }, { id: 'head', name: 'Heading', kind: 'text' }],
    'component.list': () => [{ id: 'button', name: 'Primary button', componentSet: false, variants: { Size: 'Large' }, properties: { label: { name: 'Label' } }, slots: { icon: {} } }],
  })
  const response = ok(await api.callTool('search_design_system', {
    fileKey: 'figma', includeLibraryKeys: true,
    queries: [
      { entity: 'component', query: 'button' },
      { entity: 'variable', query: 'brand' },
      { entity: 'style', query: 'body' },
      { entity: 'component', query: 'missing' },
    ],
  }))
  assert.deepEqual(response.result.results.map(entry => entry.entity), ['component', 'variable', 'style', 'component'])
  assert.equal(response.result.results[0].status, 'ok')
  assert.deepEqual(response.result.results[0].matches.map(match => match.id), ['button'])
  assert.equal(response.result.results[0].matches[0].kind, 'component')
  assert.deepEqual(response.result.results[0].matches[0].propertyKeys, ['label'])
  assert.equal(response.result.results[0].matches[0].libraryKey, 'local-document')
  assert.deepEqual(response.result.results[1].matches.map(match => match.id), ['brand'])
  assert.deepEqual(response.result.results[2].matches.map(match => match.id), ['body'])
  assert.deepEqual(response.result.results[3].matches, [])
  assert.match(response.result.note, /Code Connect mapping store/)
  const noIndex = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'component.list') }).api
  const unsupported = ok(await noIndex.callTool('search_design_system', { fileKey: 'f', queries: [{ entity: 'component', query: 'button' }] }))
  assert.equal(unsupported.result.results[0].status, 'unsupported')
  assert.deepEqual(unsupported.result.results[0].matches, [])
  const noVariables = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'variable.list') }).api
  assert.equal((await noVariables.callTool('search_design_system', { fileKey: 'f', queries: [{ entity: 'variable', query: 'x' }] })).error.code, 'method_unavailable')
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
  const { api, calls } = facade({
    'node.get': () => ({ node, ...node }),
    'component.get': () => ({ ...node, template: { 'label': 'label-node' }, instanceIds: ['instance-1'] }),
    'node.find': () => ({ nodes: [node, { id: 'text-1', name: 'Label', kind: 'text', parentId: 'button' }], nextCursor: null }),
  })
  const response = ok(await api.callTool('get_context_for_code_connect', { fileKey: 'figma', nodeId: 'button' }))
  assert.equal(response.result.format, 'futureox.component-context.v1')
  assert.equal(response.result.isComponent, true)
  assert.deepEqual(response.result.variants, { Size: 'Large' })
  assert.equal(response.result.properties.label.kind, 'text')
  assert.equal(response.result.properties.label.defaultValue, 'Go')
  assert.deepEqual(response.result.slots.icon, { name: 'Icon', targetKey: 'icon' })
  assert.deepEqual(response.result.template, { label: 'label-node' })
  assert.deepEqual(response.result.instanceIds, ['instance-1'])
  assert.deepEqual(response.result.descendants.map(entry => entry.id), ['text-1'])
  assert.equal(response.result.codeConnect.available, false)
  assert.deepEqual(response.result.codeConnect.mappings, [])
  assert.deepEqual(calls.map(call => call.method), ['node.get', 'component.get', 'node.find'])
  const plain = facade({ 'node.get': () => ({ node: { id: 'rect', name: 'Rect', kind: 'rectangle' }, id: 'rect', name: 'Rect', kind: 'rectangle' }), 'node.find': () => ({ nodes: [], nextCursor: null }) }).api
  const plainResponse = ok(await plain.callTool('get_context_for_code_connect', { fileKey: 'f', nodeId: 'rect' }))
  assert.equal(plainResponse.result.isComponent, false)
})

test('export_video validates the documented settings and refuses remote rendering', async () => {
  const { api, calls } = facade({})
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', fps: 61 })).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', jobId: 'j' })).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f' })).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', constraint: { type: 'SCALE', value: 11 } })).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', constraint: { type: 'WIDTH', value: 4097 } })).error.code, 'invalid_params')
  assert.equal((await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', ttlSeconds: 10 })).error.code, 'invalid_params')
  const start = await api.callTool('export_video', { fileKey: 'f', nodeId: 'n', fps: 30, quality: 'high', constraint: { type: 'SCALE', value: 2 }, ttlSeconds: 3600 })
  assert.equal(start.ok, false)
  assert.equal(start.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.equal(start.error.details.capability, 'figma.export.video')
  assert.equal(start.error.details.docs, FIGMA_REMOTE_DOC)
  assert.match(start.error.message, /no video job was created|Nothing was rendered/)
  const poll = await api.callTool('export_video', { fileKey: 'f', jobId: 'job-1' })
  assert.equal(poll.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.match(poll.error.message, /polling cannot succeed/)
  assert.equal(calls.length, 0)
})

test('upload_assets fences every item with the revision returned by the previous commit', async () => {
  const pngSmall = pngDataUrl(2, 3)
  const pngLarge = pngDataUrl(4, 5)
  const { api, calls } = facade({
    'document.get': () => ({}),
    'svg.import': request => ({ rootIds: ['svg-root'], warnings: ['foreign SVG approximation'], content: request.params.content }),
    'node.create': request => ({ id: `image-${request.params.width}x${request.params.height}`, patch: request.params.patch }),
  }, { mutate: ['svg.import', 'node.create'] })
  const response = ok(await api.callTool('upload_assets', {
    fileKey: 'f', count: 3, currentPageId: 'page-1', scaleMode: 'FILL',
    assets: [
      { name: 'icon', mimeType: 'image/svg+xml', content: SVG },
      { name: 'photo', mimeType: 'image/png', dataUrl: pngSmall },
      { name: 'large', mimeType: 'image/png', dataUrl: pngLarge },
    ],
  }))
  assert.equal(response.result.imported, 3)
  assert.equal(response.result.assets[0].kind, 'svg')
  assert.equal(response.result.assets[0].nodeId, 'svg-root')
  assert.equal(response.result.assets[1].kind, 'raster')
  assert.equal(response.result.assets[1].width, 2)
  assert.equal(response.result.assets[1].height, 3)
  assert.equal(response.result.assets[2].width, 4)
  assert.equal(response.result.scaleModeIgnored, true)
  assert.equal(response.revision, 7)
  const writes = calls.filter(call => ['svg.import', 'node.create'].includes(call.method))
  assert.deepEqual(writes.map(call => [call.method, call.expectedRevision]), [['svg.import', 4], ['node.create', 5], ['node.create', 6]])
  const firstCreate = writes[1]
  assert.equal(firstCreate.params.kind, 'rectangle')
  assert.equal(firstCreate.params.parentId, 'page-1')
  assert.equal(firstCreate.params.width, 2)
  assert.equal(firstCreate.params.height, 3)
  assert.equal(firstCreate.params.patch.fills[0].kind, 'image')
  assert.equal(firstCreate.params.patch.fills[0].image, pngSmall)
  const secondCreate = writes[2]
  assert.equal(secondCreate.expectedRevision, 6)
  assert.equal(secondCreate.params.patch.fills[0].image, pngLarge)
  assert.match(response.result.note, /revision returned by the previous item/)
})

test('upload_assets commits consecutive inline SVGs with the incremented revision', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'svg.import': request => ({ rootIds: [`svg-root-${request.params.name}`], warnings: [] }),
  }, { mutate: ['svg.import'] })
  const response = ok(await api.callTool('upload_assets', {
    fileKey: 'f',
    assets: [
      { name: 'first', mimeType: 'image/svg+xml', content: SVG },
      { name: 'second', mimeType: 'image/svg+xml', content: SVG },
    ],
  }))
  assert.equal(response.result.imported, 2)
  assert.equal(response.revision, 6)
  const writes = calls.filter(call => call.method === 'svg.import')
  assert.deepEqual(writes.map(call => call.expectedRevision), [4, 5])
})

test('upload_assets reports already-imported items when a later revision fence fails', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'svg.import': () => ({ rootIds: ['svg-root'], warnings: [] }),
    'node.create': () => ({ __fail: { code: 'stale_revision', message: 'The document changed during the import' } }),
  }, { mutate: ['svg.import', 'node.create'] })
  const partial = await api.callTool('upload_assets', {
    fileKey: 'f', currentPageId: 'page-1',
    assets: [
      { mimeType: 'image/svg+xml', content: SVG },
      { mimeType: 'image/png', dataUrl: pngDataUrl(2, 2) },
    ],
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.method, 'upload_assets')
  assert.equal(partial.error.code, 'stale_revision')
  assert.deepEqual(partial.error.details.imported.map(asset => asset.kind), ['svg'])
  assert.equal(partial.error.details.failedIndex, 1)
  assert.deepEqual(calls.filter(call => ['svg.import', 'node.create'].includes(call.method)).map(call => call.expectedRevision), [4, 5])
})

test('upload_assets pre-validates every asset before the first Design API call', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'svg.import': () => ({ rootIds: ['svg-root'], warnings: [] }),
    'node.create': () => ({ id: 'image-node' }),
  }, { mutate: ['svg.import', 'node.create'] })
  const noPayload = await api.callTool('upload_assets', { fileKey: 'f' })
  assert.equal(noPayload.error.code, 'inline_assets_required')
  assert.equal(calls.length, 0)
  const countMismatch = await api.callTool('upload_assets', { fileKey: 'f', count: 2, assets: [{ mimeType: 'image/svg+xml', content: SVG }] })
  assert.equal(countMismatch.error.code, 'invalid_params')
  assert.equal(calls.length, 0)
  const mixed = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ mimeType: 'image/svg+xml', content: SVG }, { mimeType: 'image/svg+xml', content: SVG, dataUrl: pngDataUrl(1, 1) }] })
  assert.equal(mixed.error.code, 'invalid_params')
  assert.match(mixed.error.message, /assets\[1\]/)
  assert.equal(calls.length, 0)
  const wrongKind = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ mimeType: 'image/png', content: SVG }] })
  assert.equal(wrongKind.error.code, 'invalid_params')
  const inferredSvg = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ content: SVG }] })
  assert.equal(inferredSvg.ok, true)
  assert.equal(inferredSvg.result.assets[0].kind, 'svg')
  assert.equal(calls.filter(call => call.method === 'svg.import').length, 1)
  calls.length = 0
  const mimeMismatch = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ mimeType: 'image/jpeg', dataUrl: pngDataUrl(1, 1) }] })
  assert.equal(mimeMismatch.error.code, 'invalid_params')
  const tooMany = await api.callTool('upload_assets', { fileKey: 'f', assets: Array.from({ length: 61 }, () => ({ content: SVG, mimeType: 'image/svg+xml' })) })
  assert.equal(tooMany.error.code, 'invalid_params')
  const tooBig = await api.callTool('upload_assets', { fileKey: 'f', assets: [{ content: '你'.repeat(4 * 1024 * 1024), mimeType: 'image/svg+xml' }] })
  assert.equal(tooBig.error.code, 'asset_too_large')
  assert.equal(calls.length, 0)
})

test('remote-only generation, capture, Make, plugin, and shader tools return typed boundaries', async () => {
  const { api, calls } = facade({})
  const callsToMake = [
    ['generate_figma_design', { fileKey: 'f', captureId: 'c' }, 'figma.capture.live_site'],
    ['generate_diagram', { mermaidSyntax: 'flowchart TD; A-->B', name: 'Flow' }, 'figma.figjam.diagram'],
    ['generate_image', { prompt: 'a cat', width: 512, height: 512, planKey: 'local::0' }, 'figma.ai.image'],
    ['generate_vector_illustration', { fileKey: 'f', prompt: 'a fox', kind: 'icon', width: 64, height: 64 }, 'figma.ai.vector'],
    ['html_to_figma', { fileKey: 'f', html: '<html><body>Hi</body></html>' }, 'figma.import.html'],
    ['send_code_to_figma', { fileKey: 'f', pageId: 'page-1' }, 'figma.make.code_layer'],
    ['list_generative_plugins', {}, 'figma.generative_plugins.catalog'],
    ['get_generative_plugin', { id: 'plugin-1', version: 'a'.repeat(40), includeSource: true }, 'figma.generative_plugins.source'],
    ['create_generative_plugin', { name: 'Renamer', description: 'Renames layers', planKey: 'local::0' }, 'figma.generative_plugins.create'],
    ['update_generative_plugin', { id: 'plugin-1', commitMessage: 'rename', files: [{ path: 'code.ts', content: 'figma.closePlugin()' }] }, 'figma.generative_plugins.update'],
    ['list_shaders', {}, 'figma.shaders.catalog'],
    ['get_shader', { id: 'shader-1', includeSource: true }, 'figma.shaders.source'],
    ['list_file_shaders', { fileKey: 'f' }, 'figma.shaders.file'],
    ['create_shader', { name: 'Contour', description: 'Fill', planKey: 'local::0', kind: 'fill' }, 'figma.shaders.create'],
    ['update_shader', { id: 'shader-1', kind: 'effect', commitMessage: 'tune', files: [{ path: 'main.ts', content: 'export default 1' }], metadata: { isAnimated: true, usesMouse: false } }, 'figma.shaders.update'],
  ]
  for (const [name, args, capability] of callsToMake) {
    const response = await api.callTool(name, args)
    assert.equal(response.ok, false, name)
    assert.equal(response.error.code, UNSUPPORTED_REMOTE_CAPABILITY, `${name}: ${response.error.code}`)
    assert.equal(response.error.details.capability, capability, name)
    assert.equal(typeof response.error.details.hint, 'string', name)
    assert.equal(response.error.details.docs, FIGMA_REMOTE_DOC, name)
    assert.equal('result' in response, false, name)
  }
  assert.equal(calls.length, 0)
  assert.equal((await api.callTool('get_generative_plugin', { id: 'p', version: 'not-a-sha' })).error.code, 'invalid_params')
  assert.equal((await api.callTool('update_shader', { id: 's', kind: 'solid', commitMessage: 'm' })).error.code, 'invalid_params')
  assert.equal((await api.callTool('create_shader', { name: 'S', description: 'D', planKey: 'local::0', kind: 'shadow' })).error.code, 'invalid_params')
})

test('the MCP server advertises and calls the remote catalog over the Figma stdio session', async t => {
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
  assert.equal(listed.result.tools.length, api.listTools().length)
  const names = listed.result.tools.map(entry => entry.name)
  for (const name of REMOTE_FIGMA_TOOL_NAMES) assert.ok(names.includes(name), name)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
  const called = await wait(3)
  assert.equal(called.result.isError, false)
  assert.equal(called.result.structuredContent.result.email, null)
  assert.match(called.result.content[0].text, /local-identity/)
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'export_video', arguments: { fileKey: 'f', nodeId: 'n' } } })
  const refused = await wait(4)
  assert.equal(refused.result.isError, true)
  assert.equal(refused.result.structuredContent.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.equal(refused.result.structuredContent.error.details.capability, 'figma.export.video')
})