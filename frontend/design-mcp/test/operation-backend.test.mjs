import test from 'node:test'
import assert from 'node:assert/strict'
import { OperationBackend } from '../src/operation-backend.mjs'

export const capabilities = { version: 1, methods: [
  { name: 'document.inspect', description: 'Inspect document', inputSchema: { type: 'object', properties: {} }, mutates: false },
  { name: 'nodes.create', description: 'Create nodes', inputSchema: { type: 'object', properties: { nodes: { type: 'array' } }, required: ['nodes'], additionalProperties: false }, mutates: true },
], limits: { maxBatchOperations: 500, maxRequestBytes: 33554432, maxQueryResults: 1000 }, unsupported: ['rendering'] }

function fixture(options = {}) {
  const calls = []
  const backend = new OperationBackend({ capabilities, execute: async (request, context) => { calls.push({ request, context }); return { ok: true, result: { actual: true }, revision: 4 } }, ...options })
  return { backend, calls }
}
test('tool catalog derives actual operation schemas and conservative annotations', () => {
  const { backend } = fixture()
  const [read, write] = backend.listTools()
  assert.equal(read.name, 'design_document_inspect')
  assert.equal(read.annotations.readOnlyHint, true)
  assert.equal(write.inputSchema.properties.params, capabilities.methods[1].inputSchema)
  assert.deepEqual(write.inputSchema.required, ['documentId', 'session', 'expectedRevision', 'params'])
  assert.equal(write.annotations.destructiveHint, true)
})
test('read-only bridge never advertises or invokes writes', async () => {
  const { backend, calls } = fixture({ scope: 'read' })
  assert.equal(backend.listTools().length, 1)
  await assert.rejects(backend.callTool('design_nodes_create', {}), /Unknown design tool/)
  assert.equal(calls.length, 0)
})
test('writes require explicit current fences and forward exact arguments', async () => {
  const { backend, calls } = fixture({ target: { documentId: 'initial', session: 0 } })
  assert.equal((await backend.callTool('design_nodes_create', { params: { nodes: [] } })).ok, false)
  assert.equal(calls.length, 0)
  const controller = new AbortController()
  const args = { documentId: 'doc', session: 2, expectedRevision: 3, params: { nodes: [{ name: 'Text' }] } }
  const result = await backend.callTool('design_nodes_create', args, { requestId: 7, signal: controller.signal })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].request, { id: 7, method: 'nodes.create', ...args })
  assert.equal(calls[0].context.signal, controller.signal)
})
test('initial read uses handshake target fences; caller overrides are preserved', async () => {
  const { backend, calls } = fixture({ target: { documentId: 'initial', session: 2 } })
  await backend.callTool('design_document_inspect', {})
  assert.deepEqual(calls[0].request, { method: 'document.inspect', params: {}, documentId: 'initial', session: 2 })
  await backend.callTool('design_document_inspect', { documentId: 'other', session: 8 })
  assert.equal(calls[1].request.documentId, 'other')
})
test('invalid wrappers never reach backend', async () => {
  const { backend, calls } = fixture()
  for (const args of [{ params: [] }, { session: -1 }, { expectedRevision: 1.5 }, { documentId: '' }, { eval: 'x' }]) {
    assert.equal((await backend.callTool('design_document_inspect', args)).error.code, 'invalid_params')
  }
  assert.equal(calls.length, 0)
})
test('normalization collisions and invalid descriptors fail closed', () => {
  assert.throws(() => fixture({ capabilities: { version: 1, methods: [...capabilities.methods, { ...capabilities.methods[0], name: 'document_inspect' }] } }), /collide/)
  assert.throws(() => fixture({ capabilities: { version: 1, methods: [{ ...capabilities.methods[0], inputSchema: {} }] } }), /descriptor/)
})
test('cancellation before execution cannot mutate', async () => {
  const { backend, calls } = fixture()
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(backend.callTool('design_document_inspect', {}, { signal: controller.signal }), /cancelled/)
  assert.equal(calls.length, 0)
})

// Helper tests only: real registry branches are exercised in schema-contract-ndjson.test.ts.
test('omitted params follow the empty-object subset and unknown assertions fail closed', async () => {
  const schemas = [
    [{ type: 'object', properties: {}, additionalProperties: false }, false],
    [{ type: 'object', required: ['id'] }, true],
    [{ type: 'object', anyOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] }, true],
    [{ type: 'object', anyOf: [{ type: 'object', required: ['a'] }, { type: 'object' }] }, false],
    [{ type: 'object', required: ['a'], anyOf: [{ type: 'object' }] }, true],
    [{ type: 'object', minProperties: 1 }, true],
    [{ type: 'object', allOf: [{ required: ['id'] }] }, true],
  ]
  for (const [inputSchema, required] of schemas) {
    let calls = 0
    const backend = new OperationBackend({ capabilities: { version: 1, methods: [{ name: 'inspect', description: 'Inspect', mutates: false, inputSchema }] }, execute: () => { calls++; return { ok: true } } })
    assert.equal(backend.listTools()[0].inputSchema.required.includes('params'), required)
    assert.equal((await backend.callTool('design_inspect', {})).ok, !required)
    assert.equal(calls, required ? 0 : 1)
  }
})
test('published fence bounds match safe-integer wrapper validation', async () => {
  const { backend, calls } = fixture()
  for (const key of ['session', 'expectedRevision']) {
    assert.equal(backend.listTools()[0].inputSchema.properties[key].maximum, Number.MAX_SAFE_INTEGER)
    assert.equal((await backend.callTool('design_document_inspect', { [key]: Number.MAX_SAFE_INTEGER + 1 })).error.code, 'invalid_params')
  }
  assert.equal(calls.length, 0)
})

test('safe integer maximum is forwarded rather than rejected as a wrapper type error', async () => {
  const { backend, calls } = fixture()
  assert.equal((await backend.callTool('design_document_inspect', { session: Number.MAX_SAFE_INTEGER, expectedRevision: Number.MAX_SAFE_INTEGER })).ok, true)
  assert.equal(calls[0].request.session, Number.MAX_SAFE_INTEGER)
  assert.equal(calls[0].request.expectedRevision, Number.MAX_SAFE_INTEGER)
})
