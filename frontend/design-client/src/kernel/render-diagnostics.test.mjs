import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderDiagnostics, renderDiagnosticError, recordRenderDiagnostic, renderDiagnostics } from './render-diagnostics.ts'
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
