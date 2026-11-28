import test from 'node:test'
import assert from 'node:assert/strict'
import { FIGMA_EXTENSION_TOOLS, FigmaFacade } from '../src/figma-facade.mjs'
import {
  FIGMA_DESKTOP_TOOL_NAMES, FIGMA_DESKTOP_TOOL_SPECS, FIGMA_DESKTOP_WRITE_TOOLS, isFigmaCloudNodeId,
} from '../src/figma-desktop-tools.mjs'

const METHODS = [
  'document.get', 'node.get', 'node.find', 'selection.get', 'component.list',
  'animation.list', 'animation.get', 'prototype.get', 'batch.apply', 'workspace.open',
]
const READ_DESKTOP = FIGMA_DESKTOP_TOOL_NAMES.filter(name => !FIGMA_DESKTOP_WRITE_TOOLS.has(name))

function facade(handlers, { scope = 'write', methods = METHODS, localSessionId, strictFigmaTools } = {}) {
  const calls = []
  let revision = 4
  const execute = async request => {
    calls.push(request)
    const handler = handlers[request.method] ?? (request.method === 'document.get' ? () => ({}) : undefined)
    if (!handler) return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision, error: { code: 'missing', message: request.method } }
    const result = await handler(request)
    return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: result?.revision ?? revision, result }
  }
  return {
    calls,
    setRevision: value => { revision = value },
    api: new FigmaFacade({
      execute, scope, strictFigmaTools, localSessionId,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' }, mutates: name === 'batch.apply' || name === 'workspace.open' })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }
const component = (id, name = `Component ${id}`) => ({ id, name, component: { variants: {}, properties: {} } })
const instance = (id, componentId) => ({ id, name: `Instance ${id}`, instance: { componentId } })

test('desktop/Dev Mode names are advertised in read and write catalogs', () => {
  assert.deepEqual(FIGMA_DESKTOP_TOOL_NAMES, [
    'get_code_connect_map', 'get_code_connect_suggestions', 'get_figjam', 'get_motion_context',
    'get_shader', 'list_shaders', 'add_code_connect_map', 'send_code_connect_mappings',
  ])
  assert.equal(FIGMA_DESKTOP_TOOL_SPECS.length, 8)
  const read = facade({}, { scope: 'read' }).api.listTools()
  assert.deepEqual(read.map(tool => tool.name).filter(name => FIGMA_DESKTOP_TOOL_NAMES.includes(name)), READ_DESKTOP)
  for (const name of FIGMA_DESKTOP_WRITE_TOOLS) assert.equal(read.some(tool => tool.name === name), false, name)
  const write = facade({}).api.listTools()
  for (const name of FIGMA_DESKTOP_TOOL_NAMES) assert.ok(write.some(tool => tool.name === name), name)
  assert.equal(read.find(tool => tool.name === 'get_motion_context').annotations.readOnlyHint, true)
  assert.equal(write.find(tool => tool.name === 'add_code_connect_map').annotations.readOnlyHint, false)
  assert.equal(write.find(tool => tool.name === 'send_code_connect_mappings').annotations.readOnlyHint, false)
})

test('extension tools stay listed and labeled by default, and only tools/list changes in strict mode', async () => {
  const handlers = { 'selection.get': () => ({ pageId: 'page-1', ids: [] }) }
  const standard = facade(handlers)
  for (const name of FIGMA_EXTENSION_TOOLS) {
    const entry = standard.api.listTools().find(tool => tool.name === name)
    assert.ok(entry, name)
    assert.match(entry.description, /^\[Futureox extension\]/, name)
    assert.match(entry.description, /FUTUREOX_FIGMA_STRICT_TOOLS/, name)
  }
  const strict = facade(handlers, { strictFigmaTools: true })
  for (const name of FIGMA_EXTENSION_TOOLS) assert.equal(strict.api.listTools().some(tool => tool.name === name), false, name)
  assert.deepEqual(ok(await strict.api.callTool('get_selection', {}, {})).result.ids, [])
  const previous = process.env.FUTUREOX_FIGMA_STRICT_TOOLS
  process.env.FUTUREOX_FIGMA_STRICT_TOOLS = '1'
  try {
    const viaEnvironment = facade(handlers).api.listTools().map(tool => tool.name)
    for (const name of FIGMA_EXTENSION_TOOLS) assert.equal(viaEnvironment.includes(name), false, name)
  } finally {
    if (previous === undefined) delete process.env.FUTUREOX_FIGMA_STRICT_TOOLS
    else process.env.FUTUREOX_FIGMA_STRICT_TOOLS = previous
  }
})

test('get_motion_context reads authored local clips and emits keyframes plus CSS', async () => {
  const clip = {
    id: 'clip-1', name: 'Card motion', pageId: 'page-1', durationMs: 1000, delayMs: 100, repeat: 'loop',
    tracks: [
      { nodeId: 'node-1', keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0], opacity: 1 } },
        { timeMs: 1000, easing: { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, value: { transform: [1, 0, 0, 1, 40, 0], opacity: 0.5 } },
      ] },
      { nodeId: 'child-1', keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0] } },
      ] },
      { nodeId: 'elsewhere', keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0] } },
      ] },
    ],
  }
  const { api, calls } = facade({
    'node.get': () => ({ node: { id: 'node-1' } }),
    'node.find': () => ({ nodes: [{ id: 'node-1' }, { id: 'child-1' }], nextCursor: null }),
    'animation.list': () => ({ clips: [{ id: 'clip-1', name: 'Card motion', pageId: 'page-1', durationMs: 1000, delayMs: 100, repeat: 'loop', trackCount: 3 }] }),
    'animation.get': () => clip,
    'prototype.get': () => ({
      startNode: 'node-1',
      interactions: { 'node-1': [{ trigger: 'click', actions: [{ kind: 'navigate', target: 'page-2' }] }], elsewhere: [{ trigger: 'click' }] },
    }),
  })
  const direct = ok(await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file' }, {}))
  assert.equal(direct.result.format, 'futureox.figma-motion.v1')
  assert.equal(direct.result.recursive, false)
  assert.deepEqual(direct.result.clips.map(entry => entry.id), ['clip-1'])
  assert.deepEqual(direct.result.clips[0].tracks.map(track => track.nodeId), ['node-1'])
  assert.equal(direct.result.clips[0].tracks[0].keyframes.length, 2)
  assert.match(direct.result.css, /@keyframes futureox-clip-1-node-1/)
  assert.match(direct.result.css, /transform: matrix\(1, 0, 0, 1, 40, 0\)/)
  assert.match(direct.result.css, /animation: futureox-clip-1-node-1 1000ms 100ms infinite both/)
  assert.match(direct.result.modelText, /1 clip\(s\), 1 track\(s\)/)
  assert.deepEqual(Object.keys(direct.result.prototype.interactions), ['node-1'])
  assert.equal(direct.result.prototype.startNode, 'node-1')
  assert.equal(calls.some(call => call.method === 'node.find'), false)

  calls.length = 0
  const recursive = ok(await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file', recursive: true }, {}))
  assert.deepEqual(recursive.result.clips[0].tracks.map(track => track.nodeId), ['node-1', 'child-1'])
  assert.equal(calls.some(call => call.method === 'node.find'), true)
  assert.match(recursive.result.css, /futureox-clip-1-child-1/)
  assert.doesNotMatch(recursive.result.css, /elsewhere/)
})

test('get_motion_context reports empty motion honestly and validates its Figma-shaped arguments', async () => {
  const { api, calls } = facade({
    'node.get': () => ({ node: { id: 'node-1' } }),
    'animation.list': () => ({ clips: [] }),
    'prototype.get': () => ({ interactions: {} }),
  })
  const empty = ok(await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file' }, {}))
  assert.deepEqual(empty.result.clips, [])
  assert.match(empty.result.modelText, /No authored animation tracks/)
  const cloud = await api.callTool('get_motion_context', { nodeId: '1:2', fileKey: 'figma-file' }, {})
  assert.equal(cloud.error.code, 'unsupported_figma_node_id')
  assert.equal((await api.callTool('get_motion_context', { nodeId: 'node-1' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'k', recursive: 'yes' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'k', cursor: 'x' }, {})).error.code, 'invalid_params')
  assert.equal(isFigmaCloudNodeId('1:2'), true)
  assert.equal(isFigmaCloudNodeId('node-1'), false)
  assert.ok(calls.every(call => call.method !== 'node.find'))
})

test('get_motion_context returns a typed boundary when no motion API is exposed', async () => {
  const { api, calls } = facade({}, { methods: ['document.get', 'node.get'] })
  const response = await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file' }, {})
  assert.equal(response.error.code, 'unsupported_remote_capability')
  assert.equal(response.error.details.capability, 'Figma keyframe motion')
  assert.equal(response.error.details.docs, 'docs/FIGMA_MCP_FACADE.md#desktop-and-dev-mode-tools')
  assert.deepEqual(calls, [])
})

test('FigJam and shader names stay discoverable and return typed capability boundaries', async () => {
  const { api, calls } = facade({})
  for (const [name, args] of [
    ['get_figjam', { nodeId: 'node-1', fileKey: 'figma-file' }],
    ['get_figjam', {}],
    ['get_shader', { id: 'shader-1' }],
    ['list_shaders', {}],
    ['list_shaders', { cursor: 'next' }],
  ]) {
    const response = await api.callTool(name, args, {})
    assert.equal(response.error.code, 'unsupported_remote_capability', name)
    assert.match(response.error.message, /was not executed/)
    assert.equal(response.error.details.docs, 'docs/FIGMA_MCP_FACADE.md#desktop-and-dev-mode-tools')
  }
  assert.deepEqual(calls, [])
  assert.equal((await api.callTool('get_figjam', { limit: 0 }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_shader', {}, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_shader', { id: 's', includeSource: 'true' }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('list_shaders', { cursor: 3 }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_figjam', { unknown: 1 }, {})).error.code, 'invalid_params')
})

test('Code Connect add, get, suggestions, and send share one local document map', async () => {
  const nodes = { 'comp-1': component('comp-1', 'Button'), 'inst-1': instance('inst-1', 'comp-1'), 'plain-1': { id: 'plain-1', name: 'Layer' } }
  const { api, calls } = facade({ 'node.get': request => ({ node: nodes[request.params.id] }) })
  const added = ok(await api.callTool('add_code_connect_map', {
    nodeId: 'comp-1', fileKey: 'figma-file', source: 'src/Button.tsx', componentName: 'Button', label: 'React',
  }, {}))
  assert.equal(added.result.stored, true)
  assert.equal(added.result.mapping.confirmed, false)
  assert.equal(added.result.mapping.componentId, 'comp-1')
  assert.equal(calls.at(-1).method, 'node.get')

  const map = ok(await api.callTool('get_code_connect_map', { nodeId: 'comp-1' }, {}))
  assert.deepEqual(map.result.mappings.map(entry => entry.source), ['src/Button.tsx'])
  assert.equal(map.result.mappings[0].stale, false)

  const instanceMap = ok(await api.callTool('get_code_connect_map', { nodeId: 'inst-1' }, {}))
  assert.equal(instanceMap.result.mappings[0].mappingNodeId, 'comp-1')

  const suggestions = ok(await api.callTool('get_code_connect_suggestions', { nodeIds: ['comp-1'] }, {}))
  assert.equal(suggestions.result.status, 'suggestions')
  assert.equal(suggestions.result.suggestions[0].status, 'suggested')
  assert.equal(suggestions.result.suggestions[0].source, 'src/Button.tsx')

  const sent = ok(await api.callTool('send_code_connect_mappings', {
    fileKey: 'figma-file', mappings: [{ nodeId: 'comp-1', source: 'src/Button.tsx', componentName: 'Button', label: 'React' }],
  }, {}))
  assert.equal(sent.result.confirmed, 1)
  assert.equal(sent.result.mappings[0].confirmed, true)
  const after = ok(await api.callTool('get_code_connect_map', { nodeId: 'comp-1' }, {}))
  assert.equal(after.result.mappings[0].confirmed, true)
  assert.equal((await api.callTool('add_code_connect_map', {
    nodeId: 'plain-1', fileKey: 'figma-file', source: 'src/Plain.tsx', componentName: 'Plain', label: 'React',
  }, {})).error.code, 'not_a_component')
})

test('Code Connect suggestions report unmapped local components without inventing a source', async () => {
  const { api } = facade({ 'node.get': request => ({ node: { id: request.params.id, name: 'Card', component: { variants: {}, properties: {} } } }) })
  const suggestions = ok(await api.callTool('get_code_connect_suggestions', { nodeId: 'comp-new' }, {}))
  assert.equal(suggestions.result.status, 'suggestions')
  assert.deepEqual(suggestions.result.suggestions, [{
    nodeId: 'comp-new', componentId: 'comp-new', role: 'component', componentName: 'Card',
    source: null, label: null, status: 'unmapped',
    note: 'No local code mapping data exists for this component. add_code_connect_map records one; no source was invented.',
  }])
  const plain = facade({ 'node.get': request => ({ node: { id: request.params.id, name: 'Layer' } }) }).api
  const ignored = await plain.callTool('get_code_connect_suggestions', { nodeId: 'plain' }, {})
  assert.equal(ignored.error.code, 'unsupported_remote_capability')
  assert.deepEqual(ignored.error.details.ignoredNodeIds, ['plain'])
  assert.equal((await api.callTool('get_code_connect_suggestions', { nodeIds: [] }, {})).error.code, 'invalid_params')
})

test('Code Connect reports the typed boundary when no local mapping exists', async () => {
  const { api, calls } = facade({ 'node.get': () => ({ node: { id: 'comp-empty', component: { variants: {}, properties: {} } } }) })
  const response = await api.callTool('get_code_connect_map', { nodeId: 'comp-empty' }, {})
  assert.equal(response.error.code, 'unsupported_remote_capability')
  assert.equal(response.error.details.mappingCount, 0)
  assert.equal(response.error.details.capability, 'Figma Code Connect mapping for the requested nodes')
  assert.deepEqual(calls.map(call => call.method), ['document.get', 'node.get'])
  assert.equal((await api.callTool('get_code_connect_map', { nodeIds: [] }, {})).error.code, 'invalid_params')
  const noSelection = facade({ 'selection.get': () => ({ ids: [] }) }, { methods: ['document.get', 'node.get', 'selection.get'] }).api
  assert.equal((await noSelection.callTool('get_code_connect_map', {}, {})).error.code, 'invalid_params')
})

test('Code Connect writes enforce conflicts, replacement, revision, and idempotent mutation ids', async () => {
  const nodes = { 'comp-2': component('comp-2'), 'comp-3': component('comp-3') }
  const { api, calls, setRevision } = facade({ 'node.get': request => ({ node: nodes[request.params.id] }) })
  const base = { nodeId: 'comp-2', fileKey: 'figma-file', source: 'src/A.tsx', componentName: 'A', label: 'React' }
  const first = ok(await api.callTool('add_code_connect_map', { ...base, mutationId: 'add-1' }, {}))
  assert.equal(first.result.stored, true)
  const conflict = await api.callTool('add_code_connect_map', { ...base, source: 'src/B.tsx' }, {})
  assert.equal(conflict.error.code, 'mapping_conflict')
  assert.equal(conflict.error.details.existing.source, 'src/A.tsx')
  const replaced = ok(await api.callTool('add_code_connect_map', { ...base, source: 'src/B.tsx', replace: true }, {}))
  assert.equal(replaced.result.replaced, true)

  calls.length = 0
  const replay = ok(await api.callTool('add_code_connect_map', { ...base, mutationId: 'add-1' }, {}))
  assert.equal(replay.result.replayed, true)
  assert.equal(replay.result.mapping.source, 'src/A.tsx')
  assert.deepEqual(calls.map(call => call.method), ['document.get'])
  const mutationConflict = await api.callTool('add_code_connect_map', { ...base, source: 'src/C.tsx', mutationId: 'add-1' }, {})
  assert.equal(mutationConflict.error.code, 'mutation_conflict')

  const added = ok(await api.callTool('add_code_connect_map', {
    nodeId: 'comp-3', fileKey: 'figma-file', source: 'src/C.tsx', componentName: 'C', label: 'React',
  }, {}))
  assert.equal(added.result.stored, true)
  setRevision(5)
  const stale = await api.callTool('send_code_connect_mappings', {
    fileKey: 'figma-file', mappings: [{ nodeId: 'comp-3', source: 'src/C.tsx', componentName: 'C', label: 'React' }],
  }, {})
  assert.equal(stale.error.code, 'stale_revision')
  assert.equal(stale.error.details.mappingRevision, 4)
  assert.equal(stale.error.details.currentRevision, 5)
  const refreshed = ok(await api.callTool('add_code_connect_map', {
    nodeId: 'comp-3', fileKey: 'figma-file', source: 'src/C.tsx', componentName: 'C', label: 'React',
  }, {}))
  assert.equal(refreshed.result.refreshed, true)
  assert.equal(refreshed.result.unchanged, false)
  const confirmed = ok(await api.callTool('send_code_connect_mappings', {
    fileKey: 'figma-file', mappings: [{ nodeId: 'comp-3', source: 'src/C.tsx', componentName: 'C', label: 'React' }],
  }, {}))
  assert.equal(confirmed.result.confirmed, 1)
  const missing = await api.callTool('send_code_connect_mappings', {
    fileKey: 'figma-file', mappings: [{ nodeId: 'comp-2', source: 'src/Z.tsx', componentName: 'Z', label: 'Vue' }],
  }, {})
  assert.equal(missing.error.code, 'not_found')
  assert.equal((await api.callTool('send_code_connect_mappings', { fileKey: 'figma-file', mappings: [] }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('add_code_connect_map', { ...base, nodeId: '1:2' }, {})).error.code, 'unsupported_figma_node_id')
})

test('Code Connect writes are rejected before the Design API in a read-only session', async () => {
  const { api, calls } = facade({}, { scope: 'read' })
  for (const [name, args] of [
    ['add_code_connect_map', { nodeId: 'n', fileKey: 'k', source: 's', componentName: 'c', label: 'React' }],
    ['send_code_connect_mappings', { fileKey: 'k', mappings: [{ nodeId: 'n', source: 's', componentName: 'c', label: 'React' }] }],
  ]) {
    const response = await api.callTool(name, args, {})
    assert.equal(response.error.code, 'read_only', name)
  }
  assert.deepEqual(calls, [])
})

test('every desktop tool asserts the transport sessionId before dispatch', async () => {
  const componentNode = { node: component('sess-comp') }
  const { api, calls } = facade({
    'node.get': () => componentNode,
    'selection.get': () => ({ ids: [] }),
    'animation.list': () => ({ clips: [] }),
    'prototype.get': () => ({ interactions: {} }),
  }, { localSessionId: 'grant-1' })
  const callsByTool = {
    get_code_connect_map: { nodeId: 'sess-comp' },
    get_code_connect_suggestions: { nodeId: 'sess-comp' },
    get_figjam: { nodeId: 'node-1' },
    get_motion_context: { nodeId: 'sess-comp', fileKey: 'k' },
    get_shader: { id: 'shader-1' },
    list_shaders: {},
    add_code_connect_map: { nodeId: 'sess-comp', fileKey: 'k', source: 'src/S.tsx', componentName: 'S', label: 'React' },
    send_code_connect_mappings: { fileKey: 'k', mappings: [{ nodeId: 'sess-comp', source: 'src/S.tsx', componentName: 'S', label: 'React' }] },
  }
  assert.deepEqual(Object.keys(callsByTool).sort(), [...FIGMA_DESKTOP_TOOL_NAMES].sort())
  for (const [name, args] of Object.entries(callsByTool)) {
    calls.length = 0
    const rejected = await api.callTool(name, { ...args, sessionId: 'another-grant' }, {})
    assert.equal(rejected.error.code, 'invalid_local_session', name)
    assert.deepEqual(calls, [], name)
    const accepted = await api.callTool(name, { ...args, sessionId: 'grant-1' }, {})
    assert.notEqual(accepted.error?.code, 'invalid_local_session', name)
  }
})