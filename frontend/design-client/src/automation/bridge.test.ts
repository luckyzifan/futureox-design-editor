import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport, type BridgeDependencies } from './bridge'
import type { AutomationResponse } from './types'
import type { captureDesignPreview } from './export'
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
function fixture(capturePreview?: typeof captureDesignPreview, host?: BridgeDependencies['host']) {
  const document = blank('Live automation'), rectangle = node('rectangle', 10, 20, 100, 60)
  document.nodes[rectangle.id] = rectangle; document.pages[0].children.push(rectangle.id)
  const editor = new Editor(document); cleanups.push(() => editor.dispose())
  let receive: ((value: DesktopAutomationRequest) => void) | undefined, cancel: ((value: { requestId: string }) => void) | undefined, serial = 0
  const waiters = new Map<string, (value: unknown) => void>()
  const register = vi.fn(async (_value: unknown) => undefined)
  const respond = vi.fn(async (value: { requestId: string; result?: unknown; error?: unknown }) => { waiters.get(value.requestId)?.(value.error ? { transportError: value.error } : value.result) })
  const recordEdit = vi.fn(async (_value: unknown) => ({ accepted: true }))
  const transport = { register, respond, recordEdit,
    onRequest: (callback: typeof receive) => { receive = callback; return () => { receive = undefined } },
    onCancel: (callback: typeof cancel) => { cancel = callback; return () => { cancel = undefined } },
  } as unknown as DesktopAutomationTransport
  const dispose = attachDesktopAutomation(editor, transport, { capturePreview, host }); cleanups.push(dispose)
  const envelope = (scope: 'read' | 'write' = 'read'): DesktopAutomationRequest => ({ requestId: `request-${++serial}`, kind: 'execute', sessionId: 'authorized-local-session', scope, documentId: editor.state.doc.id, session: editor.sessionGeneration, deadline: Date.now() + 15_000 })
  const send = (payload: DesktopAutomationRequest) => { const promise = new Promise<unknown>(resolve => waiters.set(payload.requestId, resolve)); receive!(payload); return promise }
  const call = (method: string, params: Record<string, unknown> = {}, scope: 'read' | 'write' = 'read', overrides: Partial<DesktopAutomationRequest> = {}) => {
    const base = envelope(scope)
    return send({ ...base, request: { method, params, documentId: base.documentId, session: base.session, ...(scope === 'write' ? { expectedRevision: editor.state.version } : {}) }, ...overrides }) as Promise<AutomationResponse>
  }
  return { editor, rectangle, register, respond, recordEdit, dispose, send, call, envelope, cancel: (requestId: string) => cancel?.({ requestId }) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const previewResult = { format: 'futureox.design-preview.v1', pageId: 'page', nodeIds: [], mimeType: 'image/png', name: 'test.png', dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1, scale: 1, backend: 'cpu' as const, documentId: 'doc', target: 'page' as const, bounds: { x: 0, y: 0, width: 1, height: 1 }, bytes: 3, renderer: 'product-cpu-export', screenshot: false, warnings: [] }
describe('live renderer automation bridge', () => {
  it('registers the real registry and exposes read-only capabilities/current fences', async () => {
    const f = fixture()
    expect(f.register).toHaveBeenCalledTimes(1)
    const registration = f.register.mock.calls[0][0] as { documentId: string; methods: Array<{ name: string }> }
    expect(registration.documentId).toBe(f.editor.state.doc.id)
    expect(registration.methods.some(method => method.name === 'node.create')).toBe(true)
    expect(registration.methods.some(method => method.name === 'preview.capture')).toBe(true)
    const caps = await f.send({ ...f.envelope(), kind: 'capabilities' }) as { capabilities: { methods: Array<{ mutates: boolean }> }; documentId: string; revision: number }
    expect(caps.documentId).toBe(f.editor.state.doc.id)
    expect(caps.revision).toBe(f.editor.state.version)
    expect(caps.capabilities.methods.every(method => !method.mutates)).toBe(true)
    const result = await f.call('node.get', { id: f.rectangle.id })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.result as { node: { id: string } }).node.id).toBe(f.rectangle.id)
  })
  it('double-checks scope and executes fenced edits through actual Editor history', async () => {
    const f = fixture(), original = f.editor.state.doc
    const denied = await f.call('node.update', { ids: [f.rectangle.id], patch: { name: 'Denied' } })
    expect(denied.ok).toBe(false); if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED')
    expect(f.editor.state.doc).toBe(original)
    expect((await f.call('node.update', { ids: [f.rectangle.id], patch: { name: 'Live edit' } }, 'write')).ok).toBe(true)
    expect(f.editor.state.doc.nodes[f.rectangle.id].name).toBe('Live edit'); expect(f.editor.canUndo).toBe(true)
    expect((await f.call('history.undo', {}, 'write')).ok).toBe(true)
    expect(f.editor.state.doc).toBe(original)
    expect(f.recordEdit).toHaveBeenCalledTimes(2)
    expect(f.recordEdit.mock.calls[0][0]).toMatchObject({ source: 'automation', kind: 'edit', revision: 1 })
    expect(f.recordEdit.mock.calls[1][0]).toMatchObject({ source: 'automation', kind: 'undo', revision: 2 })
    f.editor.change('Move manually', document => { document.nodes[f.rectangle.id].transform[4] += 5 })
    expect(f.recordEdit.mock.calls[2][0]).toMatchObject({ source: 'user', kind: 'edit', revision: 3 })
  })
  it('rejects missing revision, expired deadlines, wrong documents and stale revision', async () => {
    const f = fixture(), original = f.editor.state.doc, base = f.envelope('write')
    const payload = { ...base, request: { method: 'node.delete', params: { ids: [f.rectangle.id] }, documentId: base.documentId, session: base.session } }
    const missing = await f.send(payload) as AutomationResponse
    expect(missing.ok).toBe(false); if (!missing.ok) expect(missing.error.code).toBe('REVISION_REQUIRED')
    const expired = await f.call('node.delete', { ids: [f.rectangle.id] }, 'write', { deadline: Date.now() - 1 })
    expect(expired.ok).toBe(false); if (!expired.ok) expect(expired.error.code).toBe('TIMEOUT')
    const foreign = await f.call('node.delete', { ids: [f.rectangle.id] }, 'write', { documentId: 'not-this-document' })
    expect(foreign.ok).toBe(false); if (!foreign.ok) expect(foreign.error.code).toBe('STALE_SESSION')
    const stale = await f.send({ ...f.envelope('write'), request: { ...payload.request, expectedRevision: 999 } }) as AutomationResponse
    expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe('stale_revision')
    expect(f.editor.state.doc).toBe(original)
  })
  it('captures a detached snapshot and rejects stale asynchronous completion', async () => {
    const gate = deferred<typeof previewResult>(), capture = vi.fn(() => gate.promise) as unknown as typeof captureDesignPreview
    const f = fixture(capture), original = f.editor.state.doc, pending = f.call('preview.capture')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(vi.mocked(capture).mock.calls[0][0]).not.toBe(original); expect(vi.mocked(capture).mock.calls[0][0]).toEqual(original)
    await f.call('node.update', { ids: [f.rectangle.id], patch: { name: 'Changed during capture' } }, 'write')
    gate.resolve(previewResult)
    const response = await pending
    expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('STALE_REVISION')
  })
  it('cancels previews, invalidates on document switch and unregisters on unmount', async () => {
    const gate = deferred<typeof previewResult>(); let signal: AbortSignal | undefined
    const capture: typeof captureDesignPreview = (_document, options) => { signal = options?.signal; return gate.promise }
    const f = fixture(capture), base = f.envelope()
    const pending = f.send({ ...base, request: { method: 'preview.capture', documentId: base.documentId, session: base.session } }) as Promise<AutomationResponse>
    f.cancel(base.requestId); expect(signal?.aborted).toBe(true); gate.resolve(previewResult)
    const response = await pending
    expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('CANCELLED')
    f.editor.load(blank('New design')); expect(f.register).toHaveBeenCalledTimes(2)
    expect((await f.call('document.get', {}, 'read', { documentId: base.documentId, session: base.session })).ok).toBe(false)
    f.dispose(); expect(f.register).toHaveBeenLastCalledWith(null)
  })
  it('rejects unknown preview parameters before touching the export subsystem', async () => {
    const capture = vi.fn(async () => previewResult) as unknown as typeof captureDesignPreview, f = fixture(capture)
    for (const params of [{ path: '/etc/passwd' }, { scale: Infinity }, { format: 'html' }, { nodeIds: Array(257).fill('x') }]) {
      const response = await f.call('preview.capture', params)
      expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('INVALID_PARAMS')
    }
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('preview lifecycle and truthful capabilities', () => {
  it('reports the CPU export capability consistently through both capability paths', async () => {
    const f = fixture()
    const negotiated = await f.send({ ...f.envelope(), kind: 'capabilities' }) as any
    const called = await f.call('api.capabilities') as any
    expect(called.ok).toBe(true)
    expect(called.result.preview).toEqual(negotiated.capabilities.preview)
    expect(called.result.preview).toMatchObject({ renderer: 'product-cpu-export', backend: 'cpu', screenshot: false, gpuDisplayPixelEquivalence: false })
    expect(called.result.methods.some((method: any) => method.name === 'preview.capture')).toBe(true)
    expect(called.result.methods.every((method: any) => !method.mutates)).toBe(true)
  })
  it('uses the active page, includes capture fences, and does not mutate or reduce scale', async () => {
    const capture = vi.fn(async () => previewResult) as unknown as typeof captureDesignPreview, f = fixture(capture)
    f.editor.addPage()
    const document = f.editor.state.doc, version = f.editor.state.version
    const result = await f.call('preview.capture', { scale: 4 }) as any
    expect(vi.mocked(capture).mock.calls[0][1]).toMatchObject({ pageId: f.editor.state.page, scale: 4 })
    expect(result.result).toMatchObject({ documentId: document.id, session: f.editor.sessionGeneration, revision: version })
    expect(f.editor.state.doc).toBe(document); expect(f.editor.state.version).toBe(version)
  })
  it('rejects implicit active-page races but honors an explicit page target', async () => {
    const gate = deferred<typeof previewResult>(), capture = vi.fn(() => gate.promise) as unknown as typeof captureDesignPreview, f = fixture(capture)
    const oldPage = f.editor.state.page
    f.editor.addPage(); const newPage = f.editor.state.page
    const pending = f.call('preview.capture')
    f.editor.set({ page: oldPage }); gate.resolve(previewResult)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_PAGE' } })
    const explicit = f.call('preview.capture', { pageId: newPage })
    f.editor.set({ page: newPage })
    expect(await explicit).toMatchObject({ ok: true })
  })
  it('times out a non-settling renderer and keeps the bridge available for a retry', async () => {
    let signal: AbortSignal | undefined
    const capture = vi.fn((_document, options) => { signal = options?.signal; return new Promise(() => {}) }) as unknown as typeof captureDesignPreview
    const f = fixture(capture)
    expect(await f.call('preview.capture', {}, 'read', { deadline: Date.now() + 25 })).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    expect(signal?.aborted).toBe(true)
    expect(await f.call('document.get')).toMatchObject({ ok: true })
  })
  it('preserves renderer failure details without manufacturing substitute pixels', async () => {
    const capture = vi.fn(async () => { throw Object.assign(new Error('Raster unavailable'), { code: 'renderer_unavailable', details: { backend: 'cpu' } }) }) as unknown as typeof captureDesignPreview
    const f = fixture(capture), document = f.editor.state.doc
    const result = await f.call('preview.capture')
    expect(result).toMatchObject({ ok: false, error: { code: 'renderer_unavailable', details: { backend: 'cpu' } } })
    expect('result' in result).toBe(false); expect(f.editor.state.doc).toBe(document)
  })
  it('rejects empty/oversized identifiers and empty selections before capture', async () => {
    const capture = vi.fn(async () => previewResult) as unknown as typeof captureDesignPreview, f = fixture(capture)
    for (const params of [{ pageId: '' }, { pageId: 'x'.repeat(513) }, { nodeIds: [] }, { nodeIds: [''] }, { nodeIds: ['x'.repeat(513)] }])
      expect(await f.call('preview.capture', params)).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('native host-operation adapter', () => {
  it('dispatches only installed host adapters, returns raw success and preserves transport errors', async () => {
    const unavailable = fixture()
    expect(await unavailable.send({ ...unavailable.envelope(), kind: 'host', hostOperation: { method: 'workspace.current', params: {} } })).toMatchObject({ transportError: { code: 'HOST_UNAVAILABLE' } })
    const execute = vi.fn(async () => ({ current: 'opaque' })), f = fixture(undefined, { execute })
    expect(await f.send({ ...f.envelope(), kind: 'host', hostOperation: { method: 'workspace.current', params: {} } })).toEqual({ current: 'opaque' })
    expect(execute).toHaveBeenCalledTimes(1)
    execute.mockRejectedValueOnce(Object.assign(new Error('Grant denied'), { code: 'PERMISSION_DENIED' }))
    expect(await f.send({ ...f.envelope(), kind: 'host', hostOperation: { method: 'workspace.current', params: {} } })).toMatchObject({ transportError: { code: 'PERMISSION_DENIED', message: 'Grant denied' } })
    expect(await f.send({ ...f.envelope(), kind: 'host', documentId: 'foreign', hostOperation: { method: 'workspace.current', params: {} } })).toMatchObject({ transportError: { code: 'STALE_SESSION' } })
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('aborts native async work on deadline and rechecks a switched session', async () => {
    let signal: AbortSignal | undefined
    const execute = vi.fn((_payload, value: AbortSignal) => { signal = value; return new Promise(() => {}) })
    const f = fixture(undefined, { execute })
    expect(await f.send({ ...f.envelope(), kind: 'host', deadline: Date.now() + 25, hostOperation: { method: 'workspace.current', params: {} } })).toMatchObject({ transportError: { code: 'TIMEOUT' } })
    expect(signal?.aborted).toBe(true)
    const gate = deferred<unknown>()
    execute.mockImplementationOnce(() => gate.promise)
    const pending = f.send({ ...f.envelope(), kind: 'host', hostOperation: { method: 'workspace.open', params: {} } })
    f.editor.load(blank('Other document')); gate.resolve({ opened: true })
    expect(await pending).toMatchObject({ transportError: { code: 'STALE_SESSION' } })
  })
})
