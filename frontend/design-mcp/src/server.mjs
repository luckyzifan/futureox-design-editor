import { JsonLineReader, isRecord, isRequestId } from './framing.mjs'
import { ArtifactResources, previewImage } from './artifacts.mjs'
import { DESIGN_PROMPTS, getDesignPrompt } from './prompts.mjs'

// Deliberately support this released, handshake-based revision, not an unversioned draft.
export const PROTOCOL_VERSION = '2025-11-25'
export const SERVER_INFO = Object.freeze({ name: 'futureox-design', version: '0.1.0', title: 'Futureox Design' })
export const DEFAULT_LIMITS = Object.freeze({
  messageBytes: 32 * 1024 * 1024,
  standardMessageBytes: 8 * 1024 * 1024,
  toolResponseBytes: 256 * 1024,
  pendingInputBytes: 48 * 1024 * 1024,
  queuedOutputBytes: 40 * 1024 * 1024,
  concurrentRequests: 8,
  concurrentHeavyRequests: 1,
  sessionRequests: 65536,
  requestTimeoutMs: 60000,
})
const CAPABILITIES_URI = 'futureox-design://automation/capabilities'

export class ProtocolError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data }
}
const invalid = message => new ProtocolError(-32602, message)

function validTool(tool) {
  return isRecord(tool) && typeof tool.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)
    && typeof tool.description === 'string' && isRecord(tool.inputSchema) && tool.inputSchema.type === 'object'
}

/**
 * Inject a backend with listTools(context) and callTool(name, arguments, context).
 * callTool returns a JSON object (the shared operation result), never an MCP envelope.
 * All design validation, transactions and actual mutations belong to that backend.
 */
export class DesignMcpServer {
  constructor({ backend, input = process.stdin, output = process.stdout, diagnostics = process.stderr, limits = {} }) {
    if (!backend || typeof backend.listTools !== 'function' || typeof backend.callTool !== 'function') {
      throw new TypeError('A real design operation backend is required')
    }
    this.backend = backend
    this.input = input
    this.output = output
    this.diagnostics = diagnostics
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid limit: ${name}`)
    }
    this.artifacts = new ArtifactResources({ maxResponseBytes: this.limits.messageBytes })
    this.phase = 'new'
    this.requests = new Map()
    this.seen = new Set()
    this.queue = Promise.resolve()
    this.queuedBytes = 0
    this.pendingBytes = 0
    this.heavyRequests = 0
    this.closed = false
    this.started = false
    this.done = new Promise(resolve => { this.resolveDone = resolve })
    this.reader = new JsonLineReader({
      maxBytes: this.limits.messageBytes,
      onLine: line => this.receiveLine(line),
      onError: (error, kind) => { void this.sendError(undefined, kind === 'size' ? -32000 : -32700, error.message) },
    })
    this.onData = data => this.reader.push(data)
    this.onEnd = () => { this.reader.end(); void this.close() }
    this.onInputError = () => { this.log('Input stream failed'); void this.close() }
    this.onOutputError = () => { this.log('Output stream failed'); void this.close() }
  }

  start() {
    if (this.started) throw new Error('Server already started')
    this.started = true
    this.input.on('data', this.onData)
    this.input.once('end', this.onEnd)
    this.input.once('error', this.onInputError)
    this.output.on('error', this.onOutputError)
    this.input.resume?.()
    return this
  }

  log(message) { this.diagnostics?.write?.(`[futureox-design-mcp] ${message}\n`) }

  async write(message) {
    if (this.closed) return
    let line
    try { line = JSON.stringify(message) + '\n' }
    catch { line = JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Backend returned non-JSON data' } }) + '\n' }
    let size = Buffer.byteLength(line)
    if (size > this.limits.messageBytes) {
      line = JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Response exceeds the byte limit; narrow the query' } }) + '\n'
      size = Buffer.byteLength(line)
    }
    if (this.queuedBytes + size > this.limits.queuedOutputBytes) {
      this.log('Output backpressure limit reached; closing session')
      void this.close()
      return
    }
    this.queuedBytes += size
    let charged = true
    const release = () => { if (charged) { charged = false; this.queuedBytes -= size } }
    this.queue = this.queue.then(() => new Promise(resolve => {
      if (this.output.destroyed || this.output.writableEnded) return resolve()
      this.output.write(line, () => { release(); resolve() })
      // A synchronous consumer can receive the complete frame and issue its next
      // request before Node schedules this write's callback. Charge only bytes
      // still queued, not an already-drained frame awaiting callback bookkeeping.
      line = undefined
      if (this.output.writableLength === 0) release()
    })).catch(() => { this.log('Could not write protocol response') }).finally(release)
    return this.queue
  }

  sendError(id, code, message, data) {
    const error = { code, message }
    if (data !== undefined) error.data = data
    return this.write({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error })
  }

  receiveLine(line) {
    if (this.closed) return
    let message
    try { message = JSON.parse(line) }
    catch { void this.sendError(undefined, -32700, 'Invalid JSON'); return }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (message.params !== undefined && !isRecord(message.params)) || 'result' in message || 'error' in message ||
      ('id' in message && !isRequestId(message.id))) {
      void this.sendError(isRecord(message) && isRequestId(message.id) ? message.id : undefined, -32600, 'Invalid JSON-RPC request')
      return
    }
    if (!('id' in message)) { this.notification(message); return }
    const { id, method } = message
    const bytes = Buffer.byteLength(line)
    const heavy = bytes > this.limits.standardMessageBytes
    const tool = message.params?.name
    const operations = message.params?.arguments?.params?.operations
    const allowedHeavy = method === 'tools/call' && (['design_font_import', 'design_document_import', 'design_sketch_import'].includes(tool) || (tool === 'design_batch_apply' && Array.isArray(operations) && operations.some(op => ['font.import', 'document.import', 'sketch.import'].includes(op?.method))))
    if (heavy && !allowedHeavy) { void this.sendError(id, -32000, 'Ordinary requests are limited to 8 MiB; only font/document/Sketch imports and their atomic batches allow larger payloads'); return }
    if (this.seen.has(id)) { void this.sendError(id, -32600, 'Request ID has already been used in this session'); return }
    if (this.seen.size >= this.limits.sessionRequests) {
      void this.sendError(id, -32000, 'Session request limit reached; reconnect')
      return
    }
    this.seen.add(id)
    if (this.requests.size >= this.limits.concurrentRequests) {
      void this.sendError(id, -32000, 'Too many concurrent requests'); return
    }
    if (this.pendingBytes + bytes > this.limits.pendingInputBytes || (heavy && this.heavyRequests >= this.limits.concurrentHeavyRequests)) {
      void this.sendError(id, -32000, 'Pending input budget reached; wait for the current operation'); return
    }
    const state = { controller: new AbortController(), cancelled: false, method, bytes, heavy, timer: undefined }
    this.pendingBytes += bytes
    if (heavy) this.heavyRequests++
    this.requests.set(id, state)
    state.timer = setTimeout(() => {
      if (!this.requests.has(id) || state.cancelled) return
      state.cancelled = true
      state.controller.abort(new Error('Request timed out'))
      void this.sendError(id, -32000, 'Request timed out; a dispatched mutation may already have committed')
    }, this.limits.requestTimeoutMs)
    state.timer.unref?.()
    // Execute immediately: initialize and initialized in one input chunk must retain wire ordering.
    let result
    try { result = this.dispatch(method, message.params ?? {}, { signal: state.controller.signal, requestId: id }) }
    catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(
      value => { if (!state.cancelled && !this.closed) return this.write({ jsonrpc: '2.0', id, result: value }) },
      error => {
        if (state.cancelled || this.closed) return
        if (error instanceof ProtocolError) return this.sendError(id, error.code, error.message, error.data)
        this.log(`Request failed: ${method}`)
        return this.sendError(id, -32603, 'Design backend unavailable or failed')
      },
    ).finally(() => {
      clearTimeout(state.timer)
      if (this.requests.delete(id)) { this.pendingBytes -= bytes; if (heavy) this.heavyRequests-- }
    })
  }

  notification({ method, params = {} }) {
    if (method === 'notifications/initialized' && this.phase === 'initializing') this.phase = 'ready'
    if (method !== 'notifications/cancelled' || !isRequestId(params.requestId)) return
    const state = this.requests.get(params.requestId)
    if (!state || state.method === 'initialize') return
    state.cancelled = true
    clearTimeout(state.timer)
    state.controller.abort(new Error('Request cancelled by client'))
    // Cancellation is best effort and never rewinds committed design operations.
  }

  dispatch(method, params, context) {
    if (method === 'ping') return {}
    if (method === 'initialize') {
      if (this.phase !== 'new') throw invalid('Session already initialized')
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion || !isRecord(params.capabilities) ||
        !isRecord(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        throw invalid('initialize requires protocolVersion, capabilities and clientInfo')
      }
      this.phase = 'initializing'
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Live Futureox Design operation API. Read capabilities and document revision before edits. Use documentId, session and expectedRevision to protect writes. Export tool responses contain metadata and expiring resource links, not inline files. Use resources/read for client-side file saving and context.get for AI inspection. No arbitrary JavaScript, shell execution, rendering or network access is exposed. Cancellation does not roll back a mutation already committed.',
      }
    }
    if (this.phase !== 'ready') throw new ProtocolError(-32000, 'Complete initialize and notifications/initialized first')
    if (method === 'tools/list') return this.listTools(params, context)
    if (method === 'tools/call') return this.callTool(params, context)
    if (method === 'resources/list') {
      this.noCursor(params)
      return { resources: [{ uri: CAPABILITIES_URI, name: 'automation-capabilities', title: 'Live design operation capabilities', description: 'Live operation schemas and transport limits. No rendering support is implied.', mimeType: 'application/json' }, ...this.artifacts.list()] }
    }
    if (method === 'resources/templates/list') { this.noCursor(params); return { resourceTemplates: [] } }
    if (method === 'resources/read') {
      if (params.uri !== CAPABILITIES_URI) {
        const artifact = typeof params.uri === 'string' ? this.artifacts.read(params.uri) : undefined
        if (artifact) return artifact
        throw new ProtocolError(-32002, 'Resource not found or expired')
      }
      return this.listTools({}, context).then(({ tools }) => ({ contents: [{ uri: CAPABILITIES_URI, mimeType: 'application/json', text: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, limits: this.limits, tools }) }] }))
    }
    if (method === 'prompts/list') { this.noCursor(params); return { prompts: DESIGN_PROMPTS } }
    if (method === 'prompts/get') {
      try { return getDesignPrompt(params.name, params.arguments) }
      catch (error) { throw invalid(error.message) }
    }
    throw new ProtocolError(-32601, 'Method not found')
  }

  noCursor(params) {
    if (params.cursor !== undefined) throw invalid('This server returns the complete bounded catalog; no cursor is supported')
  }

  async listTools(params, context) {
    this.noCursor(params)
    const tools = await this.backend.listTools(context)
    if (!Array.isArray(tools) || tools.length > 512 || tools.some(tool => !validTool(tool)) || new Set(tools.map(tool => tool.name)).size !== tools.length) {
      throw new ProtocolError(-32603, 'Backend returned an invalid tool catalog')
    }
    return { tools }
  }

  async callTool(params, context) {
    if (typeof params.name !== 'string' || (params.arguments !== undefined && !isRecord(params.arguments))) throw invalid('tools/call requires a name and object arguments')
    if (params.task !== undefined) throw invalid('Task-augmented execution is not supported')
    const { tools } = await this.listTools({}, context)
    if (!tools.some(tool => tool.name === params.name)) throw invalid('Unknown tool name')
    if (context.signal.aborted) throw context.signal.reason
    try {
      let value = await this.backend.callTool(params.name, params.arguments ?? {}, context)
      if (!isRecord(value) || typeof value.ok !== 'boolean' || (value.ok && !('result' in value)) || (!value.ok && (!isRecord(value.error) || typeof value.error.message !== 'string'))) throw new Error('Backend returned an invalid operation response')
      const isError = value.ok === false
      const projected = this.artifacts.project(value)
      value = projected.value
      const artifacts = projected.links
      const preview = previewImage(value, this.limits.toolResponseBytes)
      const serialized = JSON.stringify(value)
      const text = Buffer.byteLength(serialized) <= 65536 ? serialized : JSON.stringify({ ok: value.ok, method: value.method, documentId: value.documentId, session: value.session, revision: value.revision, summary: 'Inspect structuredContent metadata and resource references. File bytes are available only through explicit resources/read for saving. Prefer context.get for AI inspection.' })
      const response = { content: [{ type: 'text', text }, ...artifacts, ...(preview ? [preview] : [])], structuredContent: value, isError }
      if (Buffer.byteLength(JSON.stringify(response)) > this.limits.toolResponseBytes - 2048) throw Object.assign(new Error('Tool result exceeds the 256 KiB model-context budget; narrow the selection or page the query. Large export bytes must be retrieved through resources/read. The operation may already have completed; inspect the revision before retrying a write.'), { code: 'result_too_large' })
      return response
    } catch (error) {
      if (context.signal.aborted) throw error
      // Execution failures are tool results; malformed protocol/tool names are JSON-RPC errors.
      const value = { ok: false, error: { code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'BACKEND_ERROR', message: typeof error?.message === 'string' ? error.message.slice(0, 1024) : 'Design operation failed' } }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true }
    }
  }

  async close() {
    if (this.closed) return this.done
    this.closed = true
    this.phase = 'closed'
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('error', this.onInputError)
    this.input.pause?.()
    for (const state of this.requests.values()) { state.cancelled = true; clearTimeout(state.timer); state.controller.abort(new Error('MCP session closed')) }
    this.requests.clear()
    this.pendingBytes = 0; this.heavyRequests = 0
    this.artifacts.clear()
    try { await this.backend.close?.() } catch { this.log('Backend close failed') }
    // Do not wait indefinitely for a client that stopped reading stdout.
    let timer
    await Promise.race([this.queue, new Promise(resolve => { timer = setTimeout(resolve, 200); timer.unref?.() })])
    clearTimeout(timer)
    this.resolveDone()
    return this.done
  }
}
