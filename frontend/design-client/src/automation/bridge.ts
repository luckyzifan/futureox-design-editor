import type { Editor, EditorEditEvent } from '../engine'
import type { AutomationCapabilities, AutomationMethod, AutomationRequest, AutomationResponse } from './types'
import { createEditorDesignAutomation } from './index'
import { captureDesignPreview, PREVIEW_LIMITS } from './export'

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const STANDARD_MESSAGE_BYTES = 8 * 1024 * 1024
const previewMethod: AutomationMethod = {
  name: 'preview.capture', description: 'Capture PNG/JPEG/WebP through the real product CPU raster exporter, with document/page/node/revision metadata. Defaults to the active page. This is design-content export, not a screenshot of app chrome or the GPU canvas. At most 16 megapixels and 8 MiB including base64; lower scale for inline MCP image content, otherwise read the exact image resource.', mutates: false,
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    pageId: { type: 'string', minLength: 1, maxLength: 512 }, nodeIds: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1, maxLength: 512 } },
    format: { type: 'string', enum: ['png', 'jpeg', 'webp'] }, scale: { type: 'number', minimum: 0.1, maximum: 4 },
  } },
}
export interface DesktopAutomationRequest {
  requestId: string
  kind: 'capabilities' | 'execute' | 'host'
  sessionId: string
  scope: 'read' | 'write'
  documentId: string
  session: number
  deadline: number
  request?: AutomationRequest
  hostOperation?: { method: string; params: Record<string, unknown> }
}
export interface AutomationJournalEntry {
  id: string; at: string; method: string; scope: 'read' | 'write'; documentId: string; session: number
  status: 'ok' | 'error'; code?: string; durationMs?: number; requestId?: string; revision?: number
}
export interface AutomationBridgeStatus {
  grants?: { workspace?: 'read' | 'write'; settings?: 'read' | 'write' }
  enabled: boolean; scope?: 'read' | 'write'; sessionId?: string; documentId?: string; session?: number
  editor?: { documentId: string; session: number; name: string }
  connectedClients: number; pendingRequests: number; journal: AutomationJournalEntry[]; auditError?: string
}
export interface AutomationConfig {
  auditEnabled: boolean; retentionDays: number; maxAuditEntries: number; preferredScope: 'read' | 'write'; updatedAt: number
}
export interface AutomationAuditRecord {
  id: number; event: 'grant' | 'revoke' | 'execute' | 'edit'; source?: 'user' | 'automation' | null; summary?: string | null; method?: string | null; requestId?: string | null; documentId?: string | null; session?: number | null
  revision?: number | null; status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; code?: string | null; durationMs?: number | null; scope?: 'read' | 'write' | null
  createdAt: number
}
export interface DesktopAutomationTransport {
  config(): Promise<AutomationConfig>
  configure(value: Partial<Omit<AutomationConfig, 'updatedAt'>>): Promise<AutomationConfig>
  auditHistory(value?: { limit?: number; beforeId?: number; documentId?: string; source?: 'user' | 'automation' }): Promise<{ entries: AutomationAuditRecord[]; nextBeforeId?: number | null; hasMore: boolean }>
  storageStatus(): Promise<{ available: boolean; config: AutomationConfig; auditCount: number; taskCount: number; limits: Record<string, number> }>
  status(): Promise<AutomationBridgeStatus>
  enable(value: { scope: 'read' | 'write'; workspaceScope?: 'read' | 'write'; settingsScope?: 'read' | 'write' }): Promise<AutomationBridgeStatus>
  disable(): Promise<AutomationBridgeStatus>
  copyConnection(): Promise<{ copied: boolean }>
  onStatus(callback: (value: AutomationBridgeStatus) => void): () => void
  recordEdit(value: EditorEditEvent): Promise<{ accepted: boolean }>
  register(value: { documentId: string; session: number; name: string; methods: AutomationMethod[] } | null): Promise<unknown>
  respond(value: { requestId: string; result?: unknown; error?: { code: string; message: string } }): Promise<unknown>
  onRequest(callback: (value: DesktopAutomationRequest) => void): () => void
  onCancel(callback: (value: { requestId: string }) => void): () => void
}
interface AutomationApi {
  execute(request: unknown): AutomationResponse
  capabilities(): AutomationCapabilities
  methods(): AutomationMethod[]
}
export interface BridgeDependencies {
  api?: AutomationApi
  capturePreview?: typeof captureDesignPreview
  host?: { execute(payload: DesktopAutomationRequest, signal: AbortSignal): Promise<unknown> }
}
const bridgeError = (code: string, message: string) => Object.assign(new Error(message), { code })

/** Bind only the actual mounted Editor. Merely registering never opens a listener;
 * the main process requires a native, per-document opt-in before forwarding. */
export function attachDesktopAutomation(editor: Editor, transport: DesktopAutomationTransport, dependencies: BridgeDependencies = {}): () => void {
  const api = dependencies.api ?? createEditorDesignAutomation(editor)
  const capture = dependencies.capturePreview ?? captureDesignPreview
  const methods = [...api.methods().filter(method => method.name !== previewMethod.name), previewMethod]
  const capabilities = (scope: 'read' | 'write') => ({ ...api.capabilities(), methods: methods.filter(method => scope === 'write' || !method.mutates), preview: { renderer: 'product-cpu-export', backend: 'cpu', formats: ['png', 'jpeg', 'webp'], screenshot: false, gpuDisplayPixelEquivalence: false, runtime: typeof Worker === 'function' ? 'worker-available-unprobed' : 'worker-unavailable', limits: PREVIEW_LIMITS, transport: 'MCP image content when within tool budget; exact bytes in session-local resources' } })
  const active = new Map<string, AbortController>()
  let disposed = false
  let identity = ''
  const currentIdentity = () => `${editor.sessionGeneration}:${editor.state.doc.id}`
  const register = () => {
    if (disposed || identity === currentIdentity()) return
    identity = currentIdentity()
    for (const controller of active.values()) controller.abort(bridgeError('STALE_SESSION', 'The selected design session changed'))
    // No paths, tokens, socket addresses, or generic IPC enter this renderer.
    void transport.register({ documentId: editor.state.doc.id, session: editor.sessionGeneration, name: editor.state.doc.name.slice(0, 256), methods })
      .catch(error => console.warn('Local automation registration failed:', String(error)))
  }
  const respond = async (requestId: string, result: unknown, allowLarge = false) => {
    if (disposed) return
    try {
      if (new TextEncoder().encode(JSON.stringify({ requestId, result })).byteLength > (allowLarge ? MAX_MESSAGE_BYTES : STANDARD_MESSAGE_BYTES)) throw bridgeError('FRAME_TOO_LARGE', 'Automation result exceeds the transport limit; request a smaller selection')
      await transport.respond({ requestId, result })
    } catch (error) {
      if (disposed) return
      const failure = error as Error & { code?: string }
      await transport.respond({ requestId, error: { code: failure.code ?? 'BRIDGE_ERROR', message: failure.message } }).catch(() => {})
    }
  }
  const receive = async (payload: DesktopAutomationRequest) => {
    if (disposed || active.has(payload.requestId)) return
    const controller = new AbortController()
    active.set(payload.requestId, controller)
    const documentId = editor.state.doc.id, session = editor.sessionGeneration, revision = editor.state.version
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const pageId = editor.state.page
    const request = payload.request
    const envelope = { ...(request?.id === undefined ? {} : { id: request.id }), method: request?.method ?? '', documentId, session, revision }
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      if (disposed || editor.state.doc.id !== documentId || editor.sessionGeneration !== session || payload.documentId !== documentId || payload.session !== session) throw bridgeError('STALE_SESSION', 'The request targets an editor session that is no longer selected')
      if (!Number.isFinite(payload.deadline) || Date.now() >= payload.deadline) throw bridgeError('TIMEOUT', 'The automation request expired before execution')
      if (payload.scope !== 'read' && payload.scope !== 'write') throw bridgeError('PERMISSION_DENIED', 'Invalid automation scope')
    }
    const runAsync = <T,>(work: () => Promise<T>) => {
      deadlineTimer = setTimeout(() => controller.abort(bridgeError('TIMEOUT', 'The automation deadline expired')), Math.min(2147483647, Math.max(0, payload.deadline - Date.now())))
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        check()
        try { Promise.resolve(work()).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort)) }
        catch (error) { controller.signal.removeEventListener('abort', abort); reject(error) }
      })
    }
    try {
      check()
      if (payload.kind === 'host') {
        if (!dependencies.host || !payload.hostOperation) throw bridgeError('HOST_UNAVAILABLE', 'The editor host operation adapter is unavailable')
        const result = await runAsync(() => dependencies.host!.execute(payload, controller.signal))
        check()
        await respond(payload.requestId, result)
        return
      }
      if (payload.kind === 'capabilities') {
        await respond(payload.requestId, { capabilities: capabilities(payload.scope), documentId, session, revision })
        return
      }
      if (payload.kind !== 'execute' || !request) throw bridgeError('INVALID_REQUEST', 'Invalid automation dispatch')
      const method = methods.find(method => method.name === request.method)
      if (!method) throw bridgeError('METHOD_NOT_FOUND', 'Unknown design automation method')
      if (method.mutates && payload.scope !== 'write') throw bridgeError('PERMISSION_DENIED', 'This session only permits reading')
      if (request.documentId !== documentId || request.session !== session) throw bridgeError('STALE_SESSION', 'Requests must target the selected document and session')
      if (method.mutates && (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0)) throw bridgeError('REVISION_REQUIRED', 'Writes require the observed expectedRevision')
      if (request.method === 'api.capabilities') {
        const validated = api.execute(request)
        await respond(payload.requestId, validated.ok ? { ...validated, result: capabilities(payload.scope) } : validated)
        return
      }
      if (request.method !== 'preview.capture') {
        // The shared API owns validation, fenced atomic writes and history.
        // This path is synchronous: no partially-applied asynchronous edits.
        check()
        await respond(payload.requestId, api.execute(request), ['document.export', 'sketch.export'].includes(request.method))
        return
      }
      if (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== revision)) throw bridgeError('REVISION_CONFLICT', 'The design revision changed')
      const params = request.params ?? {}
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['pageId', 'nodeIds', 'format', 'scale'].includes(key))) throw bridgeError('INVALID_PARAMS', 'Invalid preview arguments')
      if (params.pageId !== undefined && (typeof params.pageId !== 'string' || !params.pageId.length || params.pageId.length > 512)) throw bridgeError('INVALID_PARAMS', 'pageId must be a string')
      if (params.nodeIds !== undefined && (!Array.isArray(params.nodeIds) || !params.nodeIds.length || params.nodeIds.length > 256 || params.nodeIds.some(value => typeof value !== 'string' || !value.length || value.length > 512))) throw bridgeError('INVALID_PARAMS', 'nodeIds must contain at most 256 node ids')
      if (params.format !== undefined && !['png', 'jpeg', 'webp'].includes(params.format as string)) throw bridgeError('INVALID_PARAMS', 'Unsupported preview format')
      if (params.scale !== undefined && (typeof params.scale !== 'number' || !Number.isFinite(params.scale) || params.scale < 0.1 || params.scale > 4)) throw bridgeError('INVALID_PARAMS', 'Preview scale must be between 0.1 and 4')
      // Export sees a detached immutable snapshot, never a subsequently edited
      // live document. Reject stale completion instead of labelling it current.
      const document = structuredClone(editor.state.doc)
      const result = await runAsync(() => capture(document, { ...params, pageId: params.pageId as string | undefined ?? pageId, signal: controller.signal }))
      check()
      if (editor.state.version !== revision) throw bridgeError('STALE_REVISION', 'The document changed while generating the preview')
      if (params.pageId === undefined && editor.state.page !== pageId) throw bridgeError('STALE_PAGE', 'The active page changed while generating the preview; specify pageId or capture again')
      await respond(payload.requestId, { ...envelope, ok: true, result: { ...result, documentId, session, revision } })
    } catch (error) {
      const failure = (controller.signal.aborted ? controller.signal.reason : error) as Error & { code?: string; details?: unknown }
      if (payload.kind === 'host') {
        if (!disposed) await transport.respond({ requestId: payload.requestId, error: { code: failure?.code ?? 'HOST_ERROR', message: failure?.message ?? 'Host operation failed' } }).catch(() => {})
        return
      }
      await respond(payload.requestId, { ...envelope, ok: false, error: { code: failure?.code ?? (controller.signal.aborted ? 'CANCELLED' : 'BRIDGE_ERROR'), message: failure?.message ?? 'Automation request failed', ...(failure?.details === undefined ? {} : { details: failure.details }) } })
    } finally { clearTimeout(deadlineTimer); active.delete(payload.requestId) }
  }
  const unsubscribeRequest = transport.onRequest(payload => { void receive(payload) })
  const unsubscribeCancel = transport.onCancel(({ requestId }) => active.get(requestId)?.abort(bridgeError('CANCELLED', 'The automation request was cancelled')))
  const unsubscribeEditor = editor.subscribe(register)
  const unsubscribeEdits = editor.subscribeEdits(event => {
    if (!disposed) void transport.recordEdit(event).catch(error => console.warn('Local edit history could not be saved:', String(error)))
  })
  register()
  return () => {
    disposed = true
    unsubscribeRequest(); unsubscribeCancel(); unsubscribeEditor(); unsubscribeEdits()
    for (const controller of active.values()) controller.abort(bridgeError('SESSION_CLOSED', 'The editor was unmounted'))
    active.clear()
    void transport.register(null).catch(() => {})
  }
}
