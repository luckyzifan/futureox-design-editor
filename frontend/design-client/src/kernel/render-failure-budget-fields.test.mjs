import test from 'node:test'
import assert from 'node:assert/strict'
import { markRenderFailure, renderFailureFields } from './render-failure-telemetry.ts'
import { renderErrorWithBudget } from './render-diagnostics.ts'
import { createRenderDiagnostics, sanitizeFields, sanitizeBatch, sanitizeRecord } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
const budget = { requestedBytes: 80 * 1024**2, workingBytes: 220 * 1024**2, budgetBytes: 256 * 1024**2, width: 1000, height: 2000, coherent: true }
test('same rejected Error retains exact numeric allocation snapshot through worker and main relay', () => {
  const error = markRenderFailure(renderErrorWithBudget('GPU 表面内存预算超限', undefined, budget), { failureStage: 13, failureCategory: 3, failureCode: 200 })
  const fields = renderFailureFields(error)
  assert.deepEqual(fields, { failureBudgetAvailable: 1, failureRequestedBytes: budget.requestedBytes, failureWorkingBytes: budget.workingBytes,
    failureBudgetBytes: budget.budgetBytes, failureAllocationWidth: 1000, failureAllocationHeight: 2000, failureCoherent: 1,
    failureCategory: 3, failureCode: 20, failureStage: 13, errorClassCode: 1 })
  const wrapped = renderErrorWithBudget(error, 'PREVIEW_BUDGET: private document text')
  assert.deepEqual(renderFailureFields(wrapped), fields)
  const rows = [], d = createRenderDiagnostics({ enabled: true, detail: true, source: 'worker', session: 42, sink: row => rows.push(row) })
  d.record('error', { ...fields, requestId: 15, generation: 7, documentRevision: 1 }); d.flush(); d.close()
  const relayed = sanitizeRecord(sanitizeBatch(rows)[0]); assert.equal(relayed.failureRequestedBytes, budget.requestedBytes)
  assert.equal(relayed.requestId, 15); assert.equal(relayed.session, 42); assert.equal(relayed.generation, 7)
  assert(!JSON.stringify(relayed).includes('private'))
  const wire = structuredClone({ ...fields }); assert.deepEqual(sanitizeFields(wire), fields)
})
test('unknown budget snapshot is explicit unavailable and never borrowed from another Error', () => {
  const error = renderErrorWithBudget('GPU 浮点图片内存预算超限', undefined, budget)
  assert.equal(renderFailureFields(error).failureBudgetAvailable, 1)
  const next = renderFailureFields(new Error('GPU 浮点图片内存预算超限'))
  assert.equal(next.failureCode, 21); assert.equal(next.failureBudgetAvailable, 0); assert(!('failureRequestedBytes' in next))
  const cancelled = renderFailureFields(new Error('PREVIEW_CANCELLED'))
  assert.equal(cancelled.failureCategory, 1); assert(!('failureBudgetAvailable' in cancelled))
})
test('budget getters, invalid values, inherited or over-limit data never reach telemetry', () => {
  let reads = 0
  const getter = new Error('GPU 表面内存预算超限')
  Object.defineProperty(getter, 'budgetDiagnostic', { get: () => { reads++; throw Error('private') } })
  assert.equal(renderFailureFields(getter).failureBudgetAvailable, 0); assert.equal(reads, 0)
  const inherited = new Error('GPU 表面内存预算超限'); Object.setPrototypeOf(inherited, Object.assign(Object.create(Error.prototype), { budgetDiagnostic: budget }))
  assert.equal(renderFailureFields(inherited).failureBudgetAvailable, 0)
  for (const bad of [-1, .5, Infinity, NaN, '1', true, {}, 17179869185]) {
    const error = new Error('GPU 表面内存预算超限'); Object.defineProperty(error, 'budgetDiagnostic', { value: { ...budget, requestedBytes: bad } })
    assert.equal(renderFailureFields(error).failureBudgetAvailable, 0)
    assert.deepEqual(sanitizeFields({ failureRequestedBytes: bad }), {})
  }
  const under = new Error('GPU 表面内存预算超限'); Object.defineProperty(under, 'budgetDiagnostic', { value: { ...budget, requestedBytes: 1, workingBytes: 1 } })
  assert.equal(renderFailureFields(under).failureBudgetAvailable, 0)
})
test('known dictionary 20/21/64 and fallback 200 keep their existing exact meaning', () => {
  for (const [message, code] of [['GPU 表面内存预算超限', 20], ['GPU 浮点图片内存预算超限', 21], ['GPU surface budget exceeded', 64]])
    assert.equal(renderFailureFields(new Error(message)).failureCode, code)
  assert.equal(renderFailureFields(markRenderFailure(new Error('private'), { failureCategory: 3, failureCode: 200 })).failureCode, 200)
  assert.equal(renderFailureFields(new Error('private GPU 表面内存预算超限')).failureCode, 0)
})

test('actual MessageChannel preserves only allowed budget scalars through worker-style response and main recorder', async () => {
  const { MessageChannel } = await import('node:worker_threads')
  const { renderFailureEnvelope } = await import('./render-diagnostics.ts')
  const error = renderErrorWithBudget('GPU 浮点图片内存预算超限', undefined, budget)
  const { port1, port2 } = new MessageChannel()
  const response = new Promise(resolve => port2.once('message', resolve))
  port1.postMessage({ id: 73, ...renderFailureEnvelope(error), ...renderFailureFields(error), privateDocument: 'never log this' })
  const wire = await response
  const rows = [], recorder = createRenderDiagnostics({ enabled: true, source: 'main', session: 42, sink: row => rows.push(row) })
  recorder.record('error', { ...sanitizeFields(wire), requestId: wire.id })
  recorder.close(); port1.close(); port2.close()
  assert.equal(rows.length, 1); assert.equal(rows[0].failureCode, 21)
  assert.equal(rows[0].failureWorkingBytes, budget.workingBytes); assert.equal(rows[0].requestId, 73)
  assert(!('error' in rows[0])); assert(!('budgetDiagnostic' in rows[0])); assert(!JSON.stringify(rows).includes('never log this'))
})
