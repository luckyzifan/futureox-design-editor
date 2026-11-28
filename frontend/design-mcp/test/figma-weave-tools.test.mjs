import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { startLoopbackFigmaMcp } from '../src/figma-http.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_TOOLS, FigmaFacade } from '../src/figma-facade.mjs'
import {
  FIGMA_COMPATIBILITY_TOOLS, FIGMA_WEAVE_TOOL_NAMES, UNSUPPORTED_REMOTE_CAPABILITY, isCompatibilityTool,
} from '../src/figma-weave-tools.mjs'
import { FIGMA_DESKTOP_TOOL_NAMES, FIGMA_DESKTOP_WRITE_TOOLS } from '../src/figma-desktop-tools.mjs'
import { REMOTE_FIGMA_TOOLS } from '../src/figma-remote-tools.mjs'

const READ_DESKTOP_TOOL_NAMES = FIGMA_DESKTOP_TOOL_NAMES.filter(name => !FIGMA_DESKTOP_WRITE_TOOLS.has(name))

const REMOTE_READ_NAMES = REMOTE_FIGMA_TOOLS.filter(entry => entry.annotations.readOnlyHint).map(entry => entry.name)
const REMOTE_ALL_NAMES = REMOTE_FIGMA_TOOLS.map(entry => entry.name)
const COMPATIBILITY_NAMES = [
  'weave_list_tools', 'weave_get_tool_inputs', 'weave_upload_asset', 'weave_run_tool',
  'weave_get_tool_run_output', 'weave_cancel_tool_run', 'weave_find_model', 'weave_run_model',
  'weave_get_model_run_output', 'weave_request_report', 'create_session', 'create_branch',
]
const READ_METHODS = ['document.get', 'selection.get', 'variable.list', 'style.list']
const WRITE_METHODS = [...READ_METHODS, 'batch.apply', 'workspace.open']

function facade({ methods = READ_METHODS, scope = 'read', localSessionId } = {}) {
  const calls = []
  const execute = async request => {
    calls.push(request)
    return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: 4, result: { ids: [] } }
  }
  return {
    calls,
    api: new FigmaFacade({
      execute, scope, methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
      target: { documentId: 'doc-1', session: 3 }, localSessionId,
    }),
  }
}

const byName = name => FIGMA_COMPATIBILITY_TOOLS.find(entry => entry.name === name)

test('the compatibility catalog keeps its documented order and stays separate from the base facade list', () => {
  assert.deepEqual(FIGMA_COMPATIBILITY_TOOLS.map(entry => entry.name), COMPATIBILITY_NAMES)
  assert.deepEqual(FIGMA_WEAVE_TOOL_NAMES, COMPATIBILITY_NAMES.slice(0, 9))
  assert.equal(FIGMA_MCP_TOOLS.length, 8)
  for (const name of COMPATIBILITY_NAMES) assert.equal(isCompatibilityTool(name), true, name)
  assert.equal(isCompatibilityTool('get_metadata'), false)
  assert.equal(isCompatibilityTool('weave_unknown'), false)
  // Unsupported names never claim to modify local state, so read-only catalogs
  // stay readable and the loopback HTTP read-only contract keeps holding.
  assert.ok(FIGMA_COMPATIBILITY_TOOLS.every(entry => entry.annotations.readOnlyHint === true))
  assert.equal(byName('create_session').annotations.openWorldHint, false)
  for (const name of COMPATIBILITY_NAMES.filter(name => name !== 'create_session'))
    assert.equal(byName(name).annotations.openWorldHint, true, name)
})

test('weave schemas follow the documented capability summary without inventing fileKey', () => {
  const required = {
    weave_get_tool_inputs: ['recipeId'], weave_run_tool: ['recipeId'], weave_get_tool_run_output: ['recipeId'],
    weave_cancel_tool_run: ['recipeId'], weave_find_model: ['query'], weave_run_model: ['id', 'input'],
    weave_get_model_run_output: ['predictionIds'], weave_list_tools: [], weave_upload_asset: [],
  }
  for (const [name, fields] of Object.entries(required)) assert.deepEqual(byName(name).inputSchema.required, fields, name)
  assert.deepEqual(Object.keys(byName('weave_list_tools').inputSchema.properties).sort(), ['search', 'sessionId'])
  assert.deepEqual(Object.keys(byName('weave_upload_asset').inputSchema.properties), ['sessionId'])
  assert.deepEqual(Object.keys(byName('weave_run_tool').inputSchema.properties).sort(), ['acknowledgedCost', 'inputs', 'numberOfRuns', 'recipeId', 'sessionId', 'version'])
  assert.deepEqual(byName('weave_run_tool').inputSchema.properties.inputs.items.required, ['nodeId', 'value'])
  assert.deepEqual(Object.keys(byName('create_session').inputSchema.properties), ['fileKey'])
  assert.equal(byName('create_session').inputSchema.properties.sessionId, undefined)
  for (const name of FIGMA_WEAVE_TOOL_NAMES)
    assert.equal(byName(name).inputSchema.properties.fileKey, undefined, name)
  assert.deepEqual(Object.keys(byName('create_branch').inputSchema.properties).sort(), ['fileKey', 'sessionId'])
  // Connected-server-only names have no published schema, so they tolerate
  // discovery arguments instead of rejecting a guessed field.
  assert.equal(byName('weave_request_report').inputSchema.additionalProperties, true)
  assert.equal(byName('create_branch').inputSchema.additionalProperties, true)
  assert.match(byName('weave_request_report').description, /not in the public tools-and-prompts index/)
  assert.match(byName('create_branch').description, /not in the public tools-and-prompts index/)
})

test('every read-only session lists the compatibility names after the base six', () => {
  const { api } = facade()
  assert.deepEqual(api.listTools().map(tool => tool.name), [
    'get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets',
    ...READ_DESKTOP_TOOL_NAMES, ...COMPATIBILITY_NAMES, ...REMOTE_READ_NAMES,
  ])
  const write = facade({ methods: WRITE_METHODS, scope: 'write' }).api
  assert.deepEqual(write.listTools().map(tool => tool.name), [
    'get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets',
    'use_figma', 'open_document', ...FIGMA_DESKTOP_TOOL_NAMES, ...COMPATIBILITY_NAMES, ...REMOTE_ALL_NAMES,
  ])
})

test('weave names return the documented typed error and never call the Design API', async () => {
  const { api, calls } = facade()
  for (const name of [...FIGMA_WEAVE_TOOL_NAMES, 'weave_request_report']) {
    const response = await api.callTool(name, {})
    assert.equal(response.ok, false, name)
    assert.equal(response.method, name)
    assert.equal(response.error.code, UNSUPPORTED_REMOTE_CAPABILITY, name)
    assert.match(response.error.message, new RegExp(`^${name} was not executed\\.`))
    assert.match(response.error.message, /local-first/)
    assert.equal(response.error.details.docs, 'docs/FIGMA_MCP_FACADE.md#weave-sessions-and-branches')
    assert.equal(typeof response.error.details.capability, 'string')
    assert.equal('result' in response, false, name)
  }
  assert.deepEqual(calls, [])
})

test('weave arguments are advertised but not interpreted', async () => {
  const { api, calls } = facade()
  const wellFormed = await api.callTool('weave_run_tool', {
    recipeId: 'recipe-1', version: 'a'.repeat(40), inputs: [{ nodeId: 'node-1', value: 'prompt' }], numberOfRuns: 2, acknowledgedCost: 12,
  })
  const guessed = await api.callTool('weave_run_tool', { unknownField: true, acknowledgedCost: { credits: 12 } })
  assert.equal(wellFormed.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.equal(guessed.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.deepEqual(calls, [])
  const upload = await api.callTool('weave_upload_asset', {})
  assert.match(upload.error.message, /svg\.import/)
  const runModel = await api.callTool('weave_run_model', { id: 'model-1', input: { prompt: 'hello' } })
  assert.match(runModel.error.message, /use_figma/)
})

test('create_session issues the active local session that the facade accepts as sessionId', async () => {
  const { api, calls } = facade({ localSessionId: 'desktop-grant-1' })
  const created = await api.callTool('create_session', { fileKey: 'figma-file-key' })
  assert.equal(created.ok, true)
  assert.equal(created.method, 'create_session')
  assert.equal(created.result.sessionId, 'desktop-grant-1')
  assert.equal(created.result.documentId, 'doc-1')
  assert.equal(created.result.revision, 4)
  assert.equal(created.result.fileKeyIgnored, true)
  assert.match(created.result.note, /not a Figma cloud file session/)
  assert.deepEqual(calls.map(call => call.method), ['document.get'])
  const accepted = await api.callTool('get_selection', { sessionId: 'desktop-grant-1' })
  assert.equal(accepted.ok, true)
  const rejected = await api.callTool('get_selection', { sessionId: 'another-session' })
  assert.equal(rejected.error.code, 'invalid_local_session')
})

test('create_session validates its arguments and reports a transport without a session', async () => {
  const { api, calls } = facade({ localSessionId: 'desktop-grant-1' })
  const asserted = await api.callTool('create_session', { sessionId: 'desktop-grant-1' })
  assert.equal(asserted.error.code, 'invalid_params')
  assert.match(asserted.error.message, /does not accept a sessionId assertion/)
  const unknown = await api.callTool('create_session', { fileName: 'Board' })
  assert.equal(unknown.error.code, 'invalid_params')
  assert.deepEqual(calls, [])
  const unbound = await facade().api.callTool('create_session', {})
  assert.equal(unbound.ok, false)
  assert.equal(unbound.error.code, 'session_unavailable')
  assert.match(unbound.error.message, /Omit sessionId/)
})

test('create_branch reports the branch boundary and points at open_document', async () => {
  const { api, calls } = facade({ methods: WRITE_METHODS, scope: 'write' })
  const response = await api.callTool('create_branch', { fileKey: 'figma-file-key', name: 'experiment' })
  assert.equal(response.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  assert.match(response.error.message, /No branch was created/)
  assert.match(response.error.message, /open_document/)
  assert.deepEqual(calls, [])
})

test('the gaps table records each compatibility boundary', () => {
  const gap = (id) => FIGMA_MCP_GAPS.find(entry => entry.id === id)
  assert.deepEqual(FIGMA_MCP_GAPS.filter(entry => ['weave_recipes', 'weave_models', 'weave_request_report', 'create_session', 'create_branch'].includes(entry.id)).map(entry => entry.id),
    ['weave_recipes', 'weave_models', 'weave_request_report', 'create_session', 'create_branch'])
  assert.match(gap('weave_recipes').tool, /weave_list_tools/)
  assert.equal(gap('weave_models').status, 'unsupported')
  assert.equal(gap('create_session').status, 'partial')
  assert.match(gap('create_branch').detail, /Connected Figma server only/)
})

test('tools/list over MCP advertises the names and tools/call returns isError with the typed code', async t => {
  const { api, calls } = facade({ localSessionId: 'stdio-grant-1' })
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
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listed = (await wait(2)).result.tools.map(tool => tool.name)
  for (const name of COMPATIBILITY_NAMES) assert.ok(listed.includes(name), name)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'weave_list_tools', arguments: {} } })
  const weave = await wait(3)
  assert.equal(weave.result.isError, true)
  assert.equal(weave.result.structuredContent.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_session', arguments: {} } })
  const session = await wait(4)
  assert.equal(session.result.isError, false)
  assert.equal(session.result.structuredContent.result.sessionId, 'stdio-grant-1')
  assert.deepEqual(calls.map(call => call.method), ['document.get'])
})

test('the loopback HTTP entry lists the names and create_session returns its MCP session id', async t => {
  const { api, calls } = facade()
  const token = 'ab'.repeat(16)
  const server = await startLoopbackFigmaMcp({ backend: api, token, host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const authorization = `Bearer ${token}`
  const post = (body, headers = {}) => fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization, ...headers },
    body: JSON.stringify(body),
  })
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'weave-client', version: '1' } } })
  assert.equal(init.status, 200)
  const mcpSessionId = init.headers.get('mcp-session-id')
  assert.ok(mcpSessionId)
  const headers = { 'mcp-session-id': mcpSessionId, 'mcp-protocol-version': (await init.json()).result.protocolVersion }
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status, 202)
  const listed = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers)).json()).result.tools.map(tool => tool.name)
  for (const name of COMPATIBILITY_NAMES) assert.ok(listed.includes(name), name)
  const weave = (await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'weave_list_tools', arguments: {} } }, headers)).json()).result
  assert.equal(weave.isError, true)
  assert.equal(weave.structuredContent.error.code, UNSUPPORTED_REMOTE_CAPABILITY)
  const session = (await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_session', arguments: {} } }, headers)).json()).result
  assert.equal(session.isError, false)
  assert.equal(session.structuredContent.result.sessionId, mcpSessionId)
  const selection = (await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_selection', arguments: { sessionId: mcpSessionId } } }, headers)).json()).result
  assert.equal(selection.isError, false)
  assert.deepEqual(calls.filter(call => call.method === 'document.get').length, 1)
})