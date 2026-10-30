import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

test.each(['web', 'electron'])('%s worker failures keep safe, opt-in budget diagnostics', async host => {
  vi.resetModules()
  vi.stubEnv('DEV', false)
  class WorkerStub {
    static instance: WorkerStub
    messages: any[] = []
    onmessage?: (event: { data: unknown }) => void
    constructor() { WorkerStub.instance = this }
    postMessage(message: unknown) { this.messages.push(message) }
    terminate() {}
  }
  vi.stubGlobal('window', host === 'electron' ? { coreDesktop: { version: 1, renderPolicy: { cpuOnly: false } } } : {})
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('localStorage', { getItem: () => null })
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient, backendPreference, renderExecutionPolicy } = await import('./client')
  const { renderDiagnostics, renderBudgetDiagnostic, renderErrorWithBudget, renderFailureEnvelope } = await import('./render-diagnostics')
  expect(backendPreference()).toBe('webgpu')
  expect(renderExecutionPolicy.cpuOnly).toBe(false)
  expect(renderExecutionPolicy.desktopFullMath).toBe(host === 'electron')
  const client = new KernelClient(), doc = blank(), worker = WorkerStub.instance
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }
  const budget = { requestedBytes: 64, workingBytes: 80, budgetBytes: 100, width: 4, height: 4, coherent: false }
  const unsafe = { ...budget, stack: 'private-stack', nodeId: 'private-node', image: 'data:image/png;base64,SECRET', busy: [[1, 2, 3]] }
  const reject = async (envelope: { error: string; budgetDiagnostic?: unknown }) => {
    const promise = client.render(doc, options, false, 'webgpu').catch(error => error as Error)
    worker.onmessage?.({ data: { id: worker.messages.at(-1).id, ...envelope } })
    return await promise as Error
  }
  try {
    const error = renderErrorWithBudget('GPU 表面内存预算超限 private-message', undefined, unsafe)
    const envelope = structuredClone(renderFailureEnvelope(error))
    expect(renderBudgetDiagnostic(await reject(envelope))).toEqual(budget)
    expect(renderDiagnostics.snapshot()).toEqual([])
    renderDiagnostics.start()
    // Simulate extra untrusted payload keys at the receiving boundary too.
    expect(renderBudgetDiagnostic(await reject({ error: envelope.error, budgetDiagnostic: unsafe }))).toEqual(budget)
    expect(renderDiagnostics.snapshot()).toEqual([expect.objectContaining({ kind: 'error', errorCode: 'budget', ...budget })])
    expect(JSON.stringify(renderDiagnostics.report())).not.toMatch(/private-|SECRET|base64|stack|nodeId|image|busy/)
    for (const message of ['PREVIEW_CANCELLED: old budget', 'GPU device lost; old budget', 'shader validation failed'])
      expect(renderBudgetDiagnostic(await reject({ error: message, budgetDiagnostic: unsafe }))).toBeUndefined()
    expect(renderDiagnostics.snapshot()).toHaveLength(1)
    expect(renderBudgetDiagnostic(await reject({ error: 'GPU 表面内存预算超限' }))).toBeUndefined()
    expect(renderDiagnostics.snapshot()).toHaveLength(1)
    const cancelled = client.render(doc, { ...options, livePreview: true }, false, 'webgpu').catch(error => error as Error)
    const cancelledId = worker.messages.at(-1).id
    client.cancelPreview()
    expect((await cancelled as Error).message).toBe('PREVIEW_CANCELLED')
    worker.onmessage?.({ data: { id: cancelledId, ...envelope } })
    expect(renderDiagnostics.snapshot()).toHaveLength(1)
    renderDiagnostics.pause()
    await reject(envelope)
    expect(renderDiagnostics.snapshot()).toHaveLength(1)
    // A completed request does not leave a mutable previous-error payload.
    const success = client.render(doc, options, false, 'webgpu')
    worker.onmessage?.({ data: { id: worker.messages.at(-1).id, backend: 'webgpu', buffer: new ArrayBuffer(0), stats: {} } })
    await success
    expect(renderDiagnostics.snapshot()).toHaveLength(1)
  } finally { renderDiagnostics.pause(); client.dispose() }
})
