import test from 'node:test'
import assert from 'node:assert/strict'
import { FigmaFacade } from '../src/figma-facade.mjs'
import { FIGMA_DESKTOP_TOOL_SPECS, FIGMA_DESKTOP_WRITE_TOOLS } from '../src/figma-desktop-tools.mjs'

const METHODS = ['document.get', 'node.get', 'node.find', 'animation.list', 'animation.get', 'batch.apply', 'workspace.open']

function facade(handlers, { scope = 'write', methods = METHODS, extensions = false } = {}) {
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
      execute, scope, extensions,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' }, mutates: name === 'batch.apply' || name === 'workspace.open' })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }

test('desktop Figma tool names are advertised in read and write catalogs', () => {
  assert.deepEqual(FIGMA_DESKTOP_TOOL_SPECS.map(spec => spec.name), [
    'get_code_connect_map', 'get_code_connect_suggestions', 'get_figjam', 'get_motion_context',
    'get_shader', 'list_shaders', 'add_code_connect_map', 'send_code_connect_mappings',
  ])
  const read = facade({}, { scope: 'read' }).api.listTools().map(tool => tool.name)
  for (const spec of FIGMA_DESKTOP_TOOL_SPECS) {
    assert.equal(read.includes(spec.name), !FIGMA_DESKTOP_WRITE_TOOLS.has(spec.name), spec.name)
  }
  const write = facade({}).api.listTools().map(tool => tool.name)
  for (const spec of FIGMA_DESKTOP_TOOL_SPECS) assert.ok(write.includes(spec.name), spec.name)
})

test('get_motion_context reads authored local clips and emits keyframes plus CSS', async () => {
  const clip = {
    id: 'clip-1', name: 'Card motion', pageId: 'page-1', durationMs: 1000, delayMs: 100, repeat: 'loop',
    tracks: [
      { nodeId: 'node-1', rotationTurns: 0, keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0], opacity: 1 } },
        { timeMs: 1000, easing: { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, value: { transform: [1, 0, 0, 1, 40, 0], opacity: 0.5 } },
      ] },
      { nodeId: 'child-1', rotationTurns: 0, keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0] } },
      ] },
      { nodeId: 'elsewhere', rotationTurns: 0, keyframes: [
        { timeMs: 0, easing: { kind: 'linear' }, value: { transform: [1, 0, 0, 1, 0, 0] } },
      ] },
    ],
  }
  const { api, calls } = facade({
    'node.get': () => ({ id: 'node-1', node: { id: 'node-1' } }),
    'node.find': () => ({ nodes: [{ id: 'node-1' }, { id: 'child-1' }], nextCursor: null }),
    'animation.list': () => ({ clips: [{ id: 'clip-1', name: 'Card motion', pageId: 'page-1', durationMs: 1000, delayMs: 100, repeat: 'loop', trackCount: 3 }] }),
    'animation.get': () => clip,
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
  assert.equal(calls.some(call => call.method === 'node.find'), false)

  calls.length = 0
  const recursive = ok(await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file', recursive: true }, {}))
  assert.deepEqual(recursive.result.clips[0].tracks.map(track => track.nodeId), ['node-1', 'child-1'])
  assert.equal(calls.some(call => call.method === 'node.find'), true)
  assert.match(recursive.result.css, /futureox-clip-1-child-1/)
  assert.doesNotMatch(recursive.result.css, /elsewhere/)
})

test('get_motion_context reports no tracks honestly and rejects cloud ids and missing fileKey', async () => {
  const { api } = facade({
    'node.get': () => ({ id: 'node-1', node: { id: 'node-1' } }),
    'animation.list': () => ({ clips: [] }),
  })
  const empty = ok(await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file' }, {}))
  assert.deepEqual(empty.result.clips, [])
  assert.match(empty.result.modelText, /No authored animation tracks/)
  const cloud = await api.callTool('get_motion_context', { nodeId: '1:2', fileKey: 'figma-file' }, {})
  assert.equal(cloud.error.code, 'unsupported_figma_node_id')
  const missing = await api.callTool('get_motion_context', { nodeId: 'node-1' }, {})
  assert.equal(missing.error.code, 'invalid_params')
})

test('get_motion_context reports an unavailable local animation API instead of inventing motion', async () => {
  const { api } = facade({}, { methods: ['document.get', 'node.get'] })
  const response = await api.callTool('get_motion_context', { nodeId: 'node-1', fileKey: 'figma-file' }, {})
  assert.equal(response.error.code, 'unsupported_remote_capability')
})

test('unimplemented desktop capabilities keep the tool visible and return a typed error without API calls', async () => {
  const { api, calls } = facade({})
  const expectations = [
    ['get_code_connect_map', { fileKey: 'figma-file' }],
    ['get_code_connect_suggestions', {}],
    ['get_figjam', {}],
    ['get_shader', { id: 'shader-1' }],
    ['list_shaders', {}],
    ['add_code_connect_map', { nodeId: 'node-1', fileKey: 'figma-file', source: 'src/Button.tsx', componentName: 'Button', label: 'React' }],
    ['send_code_connect_mappings', { fileKey: 'figma-file', mappings: [{ nodeId: 'node-1', source: 'src/Button.tsx' }] }],
  ]
  for (const [name, args] of expectations) {
    const response = await api.callTool(name, args, {})
    assert.equal(response.error.code, 'unsupported_remote_capability', name)
    assert.match(response.error.message, /no local Futureox implementation/, name)
  }
  assert.deepEqual(calls, [])
})