import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeRuntimeConfiguration, markRuntimeConfiguration, runtimeConfigurationFields, inheritRuntimeConfiguration } from '../src/render-runtime-configuration.mjs'
import { createRenderDiagnostics, sanitizeFields, sanitizeBatch } from '../src/render-terminal-diagnostics.mjs'
const config = { runtimeConfigVersion: 1, runtimeImageAtlas: 0, runtimeImageMips: 1,
  runtimeDriverCode: 2, runtimeDriverManaged: 1, runtimeHdr: 0, runtimeFloatUpload: 1,
  runtimeReadback: 0, runtimePresent: 1, runtimeWorkingBudgetBytes: 1073741824,
  runtimeBudgetSource: 1, runtimeConfiguredBudgetMiB: 0 }

test('only bounded own numeric fields pass; no getters, strings, paths or payloads', () => {
  let reads = 0
  const getter = { runtimeConfigVersion: 1 }
  Object.defineProperty(getter, 'runtimeImageAtlas', { get() { reads++; throw Error('private') } })
  assert.deepEqual(sanitizeRuntimeConfiguration(getter), { runtimeConfigVersion: 1 }); assert.equal(reads, 0)
  assert.deepEqual(sanitizeRuntimeConfiguration(Object.create(config)), {})
  assert.deepEqual(sanitizeRuntimeConfiguration({ ...config, env: 'secret', document: 'private' }), config)
  for (const invalid of [NaN, Infinity, -1, .5, 2, '1', true, {}])
    assert(!('runtimeImageAtlas' in sanitizeFields({ runtimeConfigVersion: 1, runtimeImageAtlas: invalid })))
  assert(!('runtimeWorkingBudgetBytes' in sanitizeFields({ runtimeConfigVersion: 1, runtimeWorkingBudgetBytes: 4294967297 })))
  assert.deepEqual(sanitizeRuntimeConfiguration({ runtimeConfigVersion: 2, runtimeImageAtlas: 1 }), {})
})

test('error-owned immutable snapshot survives wrappers and never borrows another error state', () => {
  const original = new Error('private'), data = { ...config }
  assert.equal(markRuntimeConfiguration(original, data), original); data.runtimeImageAtlas = 1
  const wrapper = new Error('wrapped private')
  assert.equal(inheritRuntimeConfiguration(original, wrapper), wrapper)
  assert.deepEqual(runtimeConfigurationFields(wrapper), config)
  const copy = runtimeConfigurationFields(wrapper); copy.runtimeImageAtlas = 1
  assert.equal(runtimeConfigurationFields(original).runtimeImageAtlas, 0)
  assert.deepEqual(runtimeConfigurationFields(new Error('private')), {})
})

test('real MessageChannel and both existing sanitizers preserve runtime scalars with request correlation', async () => {
  const { MessageChannel } = await import('node:worker_threads')
  const { port1, port2 } = new MessageChannel(), rows = []
  try {
    const received = new Promise(resolve => port2.once('message', resolve))
    port1.postMessage({ ...config, requestId: 117, failureCode: 21, privateText: 'never log this' })
    const wire = await received
    const recorder = createRenderDiagnostics({ enabled: true, detail: true, session: 9, source: 'main',
      sink: row => rows.push(row) })
    recorder.record('runtime-config', sanitizeFields(wire)); recorder.record('error', sanitizeFields(wire))
    recorder.flush(); recorder.close()
    const clean = sanitizeBatch(rows)
    assert.equal(clean.length, 2)
    for (const row of clean) {
      assert.equal(row.runtimeImageAtlas, 0); assert.equal(row.runtimeWorkingBudgetBytes, 1073741824)
      assert.equal(row.requestId, 117); assert.equal(row.session, 9)
      assert(!JSON.stringify(row).includes('never log this'))
    }
  } finally { port1.close(); port2.close() }
})
