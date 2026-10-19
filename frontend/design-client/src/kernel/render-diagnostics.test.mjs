import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderDiagnostics, renderDiagnosticError, recordRenderDiagnostic, renderDiagnostics,
  sanitizeRenderBudget, renderBudgetDiagnostic, renderErrorWithBudget, renderFailureEnvelope } from './render-diagnostics.ts'
import { renderProfile, recordRenderProfile } from './render-profile.ts'

test('actual recorder is disabled by default and pause prevents new samples', () => {
  let clockCalls = 0
  const journal = createRenderDiagnostics(512, () => ++clockCalls)
  journal.record({ kind: 'request', zoom: 32 })
  assert.equal(clockCalls, 0)
  assert.deepEqual(journal.snapshot(), [])
  journal.start(); journal.record({ kind: 'request', zoom: 32 })
  journal.pause(); journal.record({ kind: 'present', publishedDensity: 64 })
  assert.equal(journal.snapshot().length, 1)
  assert.equal(clockCalls, 1)
  assert.equal(journal.recording, false)
})

test('zoom request, cache result, fresh pixels and failure retain exact scalars', () => {
  const journal = createRenderDiagnostics(512, () => 12.5)
  journal.start()
  journal.record({ kind: 'request', zoom: 32, dpr: 2, requestedDensity: 64, publishedDensity: 16 })
  journal.record({ kind: 'cache', cacheHits: 3, cacheMisses: 7 })
  journal.record({ kind: 'tile', sampledDensity: 64, totalMs: 40, compileMs: 10, graphMs: 32, finishMs: 4, checkpointMs: 11 })
  journal.record({ kind: 'present', zoom: 32, dpr: 2, requestedDensity: 64, publishedDensity: 64 })
  journal.record({ kind: 'error', errorCode: renderDiagnosticError(new Error('GPU 表面内存预算超限')) })
  const samples = journal.snapshot()
  assert.deepEqual(samples[0], { kind: 'request', sequence: 1, at: 12.5, zoom: 32, dpr: 2, requestedDensity: 64, publishedDensity: 16 })
  assert.deepEqual(samples[1], { kind: 'cache', sequence: 2, at: 12.5, cacheHits: 3, cacheMisses: 7 })
  assert.equal(samples[2].totalMs, 40) // Timings are not incorrectly added together.
  assert.equal(samples[2].checkpointMs, 11)
  assert.equal(samples[2].sampledDensity, 64)
  assert.equal(samples[2].publishedDensity, undefined) // Received does not mean presented.
  assert.equal(samples[3].publishedDensity, 64)
  assert.equal(samples[4].errorCode, 'budget')
})

test('ring stays bounded, reports dropped entries, and restart resets it', () => {
  const journal = createRenderDiagnostics(512, () => 0)
  journal.start()
  for (let i = 0; i < 600; i++) journal.record({ kind: 'tile', cacheHits: i })
  assert.equal(journal.snapshot().length, 512)
  assert.equal(journal.snapshot()[0].sequence, 89)
  assert.equal(journal.snapshot().at(-1).sequence, 600)
  assert.equal(journal.report().dropped, 88)
  journal.start(); journal.record({ kind: 'present' })
  assert.equal(journal.snapshot()[0].sequence, 1)
  assert.equal(journal.report().dropped, 0)
  for (const capacity of [0, -1, NaN, Infinity, 1.5, 513])
    assert.throws(() => createRenderDiagnostics(capacity), RangeError)
})

test('unknown keys, raw errors, document IDs and image payloads cannot enter exports', () => {
  const journal = createRenderDiagnostics(512, () => 0)
  journal.start()
  journal.record({ kind: 'error', errorCode: 'private-message-secret', documentId: 'private-id',
    image: 'data:image/png;base64,SECRET', message: 'private-message-secret', payload: { secret: 'private-payload' } })
  journal.record({ kind: 'private-kind-secret', zoom: 32 })
  assert.deepEqual(journal.snapshot(), [{ kind: 'error', sequence: 1, at: 0, errorCode: 'unknown' }])
  const exported = JSON.stringify(journal.report())
  assert.doesNotMatch(exported, /SECRET|private-|base64|documentId|payload/)
})

test('invalid numeric fields are omitted, zero timings and cache counts are preserved', () => {
  const journal = createRenderDiagnostics(512, () => NaN)
  journal.start()
  journal.record({ kind: 'tile', zoom: NaN, dpr: -1, requestedDensity: Infinity, publishedDensity: 0,
    cacheHits: 0, cacheMisses: 1.5, totalMs: -1, compileMs: 0, graphMs: Infinity, finishMs: 'secret', checkpointMs: 0 })
  assert.deepEqual(journal.snapshot(), [{ kind: 'tile', sequence: 1, at: 0, cacheHits: 0, compileMs: 0, checkpointMs: 0 }])
})

test('snapshot and report cannot mutate retained samples', () => {
  const journal = createRenderDiagnostics(512, () => 1)
  journal.start(); journal.record({ kind: 'request', zoom: 32 })
  const snapshot = journal.snapshot()
  assert.throws(() => { snapshot[0].zoom = 1 }, TypeError)
  snapshot.pop(); journal.report().samples.pop()
  assert.equal(journal.snapshot()[0].zoom, 32)
})

test('error classifier returns only bounded codes and handles non-errors', () => {
  for (const [input, code] of [
    [new Error('GPU device lost; private-data'), 'device-lost'],
    ['显示瓦片缓存预算超限', 'budget'], ['superseded request', 'cancelled'],
    ['render timed out', 'timeout'], ['unknown private-data', 'unknown'], [null, 'unknown'],
    ['x'.repeat(512) + 'budget exceeded', 'unknown'],
  ]) assert.equal(renderDiagnosticError(input), code)
})

test('existing render profile controls both journals; restart/pause are shared', () => {
  try {
    renderProfile.start()
    recordRenderProfile('tile', { milliseconds: 12, graphMs: 10, checkpointMs: 2 })
    recordRenderDiagnostic({ kind: 'present', zoom: 32, dpr: 2, requestedDensity: 64, publishedDensity: 64 })
    assert.equal(renderProfile.snapshot().length, 1)
    assert.equal(renderProfile.diagnostics().samples.length, 1)
    assert.equal(renderDiagnostics.recording, true)
    renderProfile.pause()
    recordRenderDiagnostic({ kind: 'error' })
    assert.equal(renderProfile.diagnostics().samples.length, 1)
    assert.equal(renderDiagnostics.recording, false)
    renderProfile.start()
    assert.deepEqual(renderProfile.snapshot(), [])
    assert.deepEqual(renderProfile.diagnostics().samples, [])
  } finally { renderProfile.pause() }
})

const budget = { requestedBytes: 64, workingBytes: 80, budgetBytes: 100, width: 4, height: 4, coherent: false }
test('budget exports contain only validated scalar allocation facts, with recording still opt-in', () => {
  const journal = createRenderDiagnostics(512, () => 0)
  const input = { kind: 'error', errorCode: 'budget', ...budget, nodeId: 'private-node',
    document: 'private-document', image: 'data:image/png;base64,SECRET', stack: 'private-stack',
    busy: [[64, 64, 65536]], x: 123, y: -456, retained: true }
  journal.record(input)
  assert.deepEqual(journal.snapshot(), [])
  journal.start(); journal.record(input)
  assert.deepEqual(journal.snapshot(), [{ kind: 'error', sequence: 1, at: 0, errorCode: 'budget', ...budget }])
  assert.doesNotMatch(JSON.stringify(journal.report()), /private-|SECRET|base64|nodeId|document|image|stack|busy|retained|"x"|"y"/)
  journal.pause(); journal.record(input)
  assert.equal(journal.snapshot().length, 1)
})

test('budget validation rejects malformed bytes and omits unknown or invalid optional fields', () => {
  for (const field of ['requestedBytes', 'workingBytes', 'budgetBytes'])
    for (const value of [-1, 1.5, Infinity, NaN, 'private-data', Number.MAX_SAFE_INTEGER + 1, undefined])
      assert.equal(sanitizeRenderBudget({ ...budget, [field]: value }), undefined)
  assert.equal(sanitizeRenderBudget({ ...budget, budgetBytes: 0 }), undefined)
  assert.equal(sanitizeRenderBudget({ ...budget, budgetBytes: 144 }), undefined)
  assert.equal(sanitizeRenderBudget(null), undefined)
  assert.equal(sanitizeRenderBudget('private-data'), undefined)
  assert.deepEqual(sanitizeRenderBudget({ ...budget, width: -1, height: Infinity, coherent: 'private-data' }),
    { requestedBytes: 64, workingBytes: 80, budgetBytes: 100 })
  assert.deepEqual(sanitizeRenderBudget({ requestedBytes: 0, workingBytes: 101, budgetBytes: 100, coherent: true }),
    { requestedBytes: 0, workingBytes: 101, budgetBytes: 100, coherent: true })
  assert.ok(Object.isFrozen(sanitizeRenderBudget(budget)))
})

test('only actual budget error records admit bytes; unrelated events and errors stay class-only', () => {
  const journal = createRenderDiagnostics(512, () => 0); journal.start()
  for (const errorCode of ['cancelled', 'device-lost', 'timeout', 'unknown', 'private-data'])
    journal.record({ kind: 'error', errorCode, ...budget })
  for (const kind of ['tile', 'present', 'request', 'cache'])
    journal.record({ kind, errorCode: 'budget', ...budget })
  for (const sample of journal.snapshot()) {
    assert.equal(sample.requestedBytes, undefined)
    assert.equal(sample.width, undefined)
    assert.equal(sample.coherent, undefined)
  }
})

test('worker wrappers and structured clone retain safe summary without serializing stack or payload', () => {
  const initial = renderErrorWithBudget('GPU 表面内存预算超限', undefined,
    { ...budget, stack: 'private-stack', nodeId: 'private-node', image: 'data:image/png;base64,SECRET' })
  const wrapped = renderErrorWithBudget(initial, `PREVIEW_BUDGET: webgpu: ${initial.message}`)
  const message = structuredClone(renderFailureEnvelope(wrapped))
  const received = renderErrorWithBudget(message.error, undefined, message.budgetDiagnostic)
  assert.deepEqual(renderBudgetDiagnostic(received), budget)
  assert.deepEqual(Object.keys(message), ['error', 'budgetDiagnostic'])
  assert.doesNotMatch(JSON.stringify(message), /private-|SECRET|base64|stack|nodeId|image/)
  assert.deepEqual(Object.keys(initial), [], 'Error metadata is not an enumerable raw payload')
})

test('cancellation, device loss and unrelated failures cannot inherit stale budget summaries', () => {
  for (const message of ['PREVIEW_CANCELLED', 'PREVIEW_CANCELLED: old budget', 'GPU device lost; budget exceeded', 'shader validation failed']) {
    const error = renderErrorWithBudget(message, undefined, budget)
    assert.equal(renderBudgetDiagnostic(error), undefined)
    assert.deepEqual(renderFailureEnvelope(error), { error: message })
  }
  assert.equal(renderBudgetDiagnostic(renderErrorWithBudget('GPU 表面内存预算超限')), undefined)
  assert.equal(renderDiagnosticError('PREVIEW_CANCELLED: old budget'), 'cancelled')
  assert.equal(renderDiagnosticError('x'.repeat(512) + ' budget'), 'unknown')
})

test('bounded budget records survive eviction without retaining mutable sources', () => {
  const journal = createRenderDiagnostics(2, () => 0); journal.start()
  const input = { kind: 'error', errorCode: 'budget', ...budget }
  for (let i = 0; i < 3; i++) journal.record(input)
  input.requestedBytes = 999
  assert.equal(journal.report().dropped, 1)
  assert.equal(journal.snapshot().length, 2)
  assert.equal(journal.snapshot()[0].requestedBytes, 64)
  journal.start(); journal.record({ kind: 'error', errorCode: 'unknown' })
  assert.deepEqual(journal.snapshot(), [{ kind: 'error', errorCode: 'unknown', sequence: 1, at: 0 }])
})
