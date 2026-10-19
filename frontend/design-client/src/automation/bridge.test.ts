import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport } from './bridge'
import type { AutomationResponse } from './types'
import type { captureDesignPreview } from './export'
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
function fixture(capturePreview?: typeof captureDesignPreview) {
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
  const dispose = attachDesktopAutomation(editor, transport, { capturePreview }); cleanups.push(dispose)
  const envelope = (scope: 'read' | 'write' = 'read'): DesktopAutomationRequest => ({ requestId: `request-${++serial}`, kind: 'execute', sessionId: 'authorized-local-session', scope, documentId: editor.state.doc.id, session: editor.sessionGeneration, deadline: Date.now() + 15_000 })
  const send = (payload: DesktopAutomationRequest) => { const promise = new Promise<unknown>(resolve => waiters.set(payload.requestId, resolve)); receive!(payload); return promise }
  const call = (method: string, params: Record<string, unknown> = {}, scope: 'read' | 'write' = 'read', overrides: Partial<DesktopAutomationRequest> = {}) => {
    const base = envelope(scope)
    return send({ ...base, request: { method, params, documentId: base.documentId, session: base.session, ...(scope === 'write' ? { expectedRevision: editor.state.version } : {}) }, ...overrides }) as Promise<AutomationResponse>
  }
  return { editor, rectangle, register, respond, recordEdit, dispose, send, call, envelope, cancel: (requestId: string) => cancel?.({ requestId }) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const previewResult = { format: 'futureox.design-preview.v1', pageId: 'page', nodeIds: [], mimeType: 'image/png', name: 'test.png', dataUrl: 'data:image/png;base64,AAAA', width: 1, height: 1, scale: 1, backend: undefined, warnings: [] }
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
