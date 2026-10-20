import { afterEach, expect, test, vi } from 'vitest'
import { createCanvasOperationDiagnostics, operationCorrelation } from './canvas-operation-terminal'
import { sanitizeBatch, sanitizeRecord, sanitizeFields, PREFIX } from '../../design-desktop/src/render-terminal-diagnostics.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
test('detail operation records traverse renderer batch and host double-sanitization without content', () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { coreDesktop: { renderDiagnostics: true, renderDiagnosticsDetail: true } })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const collector = createCanvasOperationDiagnostics(), doc = {}
  const op = collector.begin(4, 8, 'text', 1)
  for (let i = 0; i < 1000; i++) collector.preview(op, true)
  collector.finish(op, 'committed', 4, 9, doc, 'SECRET PAGE')
  collector.acknowledge(4, 9, doc, 'SECRET PAGE', false)
  expect(log).not.toHaveBeenCalled()
  vi.advanceTimersByTime(250)
  const messages = log.mock.calls.map(([line]) => JSON.parse(String(line).slice(PREFIX.length)))
  const hostRows = messages.flatMap(message => sanitizeBatch(message.batch))
  expect(hostRows).toHaveLength(3)
  expect(hostRows.map(row => row.operationPhase)).toEqual([1, 2, 3])
  expect(hostRows[1]).toMatchObject({ operationId: op, operationSession: 4, operationCategory: 3, operationOutcome: 1, startRevision: 8, authoredRevision: 9, previewAttempts: 1000, previewAccepted: 1000 })
  expect(hostRows.map(sanitizeRecord)).toEqual(hostRows)
  expect(JSON.stringify(hostRows)).not.toContain('SECRET')
  collector.close()
})
test('default dev summary emits finish and bounded aggregate instead of per-preview terminal traffic', () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { coreDesktop: { renderDiagnostics: true } })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const collector = createCanvasOperationDiagnostics()
  for (let i = 0; i < 200; i++) {
    const op = collector.begin(0, i, 'move', 1)
    for (let j = 0; j < 100; j++) collector.preview(op, true)
    collector.finish(op, 'cancelled', 0, i)
  }
  expect(log.mock.calls.length).toBe(8)
  vi.advanceTimersByTime(1000)
  expect(log.mock.calls.length).toBe(10)
  const row = sanitizeRecord(JSON.parse(String(log.mock.calls.at(-1)![0]).slice(PREFIX.length)))
  expect(row).toMatchObject({ event: 'operation', operationOutcome: 2, previewAttempts: 100, sampleCount: 392 })
  collector.close()
})
test('operation fields reject nonintegers, negative/out-of-enum numbers, and injected content', () => {
  expect(sanitizeFields({ operationPhase: 5, operationOutcome: 6, operationCategory: -1, operationId: 1.5, targetCount: Infinity, text: 'SECRET', name: 'SECRET', startRevision: 1e10 })).toEqual({})
  expect(sanitizeFields({ operationPhase: 3, operationOutcome: 5, operationCategory: 6, operationId: 42, operationSession: 0 })).toMatchObject({ operationPhase: 3, operationOutcome: 5, operationCategory: 6, operationId: 42, operationSession: 0 })
})

test('two editors and a reloaded session cannot alias operation/revision correlation', () => {
  const first = createCanvasOperationDiagnostics(), second = createCanvasOperationDiagnostics()
  const a = {}, b = {}, reloaded = {}
  const one = first.begin(0, 0, 'move', 1), two = second.begin(0, 0, 'resize', 1)
  first.finish(one, 'committed', 0, 1, a, 'first')
  second.finish(two, 'committed', 0, 1, b, 'second')
  const ca = operationCorrelation(a), cb = operationCorrelation(b)
  expect(ca.operationId).toBe(cb.operationId); expect(ca.authoredRevision).toBe(cb.authoredRevision)
  expect(ca.operationOwner).not.toBe(cb.operationOwner)
  const captured = operationCorrelation(a)
  first.endSession()
  const next = first.begin(1, 0, 'property', 1)
  first.finish(next, 'committed', 1, 1, reloaded, 'first')
  expect(operationCorrelation(reloaded)).toMatchObject({ operationOwner: ca.operationOwner, operationSession: 1, authoredRevision: 1 })
  expect(operationCorrelation(reloaded).operationId).not.toBe(ca.operationId)
  expect(captured).toEqual(ca)
  expect(operationCorrelation({})).toEqual({})
  first.close(); second.close()
})

test('real KernelClient request log carries captured operation join keys through host sanitizer', async () => {
  const { KernelClient } = await import('./kernel/client')
  const { blank } = await import('./model')
  vi.stubGlobal('window', { coreDesktop: { renderDiagnostics: true } })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let worker: { onmessage?: (event: { data: unknown }) => void; messages: Record<string, unknown>[] }
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: unknown }) => void
    messages: Record<string, unknown>[] = []
    constructor() { worker = this }
    postMessage(value: Record<string, unknown>) { this.messages.push(value) }
    terminate() {}
  })
  const collector = createCanvasOperationDiagnostics(), client = new KernelClient(), document = blank()
  try {
    const operation = collector.begin(3, 4, 'resize', 1)
    collector.finish(operation, 'committed', 3, 5, document, document.pages[0].id)
    const expected = operationCorrelation(document)
    const pending = client.render(document, { pageId: document.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false }, false, 'cpu')
    await Promise.resolve()
    const request = worker!.messages.find(value => typeof value.id === 'number')!
    expect(request).toBeDefined()
    worker!.onmessage?.({ data: { id: request.id, backend: 'cpu', milliseconds: 0, stats: { nodes: 0 } } })
    await pending
    const rows = log.mock.calls.map(([line]) => sanitizeRecord(JSON.parse(String(line).slice(PREFIX.length)))).filter(Boolean)
    const submitted = rows.find(row => row!.event === 'request')!
    expect(submitted).toMatchObject({ ...expected, requestId: request.id })
    const completed = rows.find(row => row!.event === 'result')!
    expect(completed).toMatchObject({ session: submitted.session, requestId: submitted.requestId })
    expect(JSON.stringify(request)).not.toContain('operationOwner') // diagnostics are not render payloads
  } finally { collector.close(); client.dispose() }
})
