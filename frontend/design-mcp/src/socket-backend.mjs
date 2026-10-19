import net from 'node:net'
import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { JsonLineReader, isRecord } from './framing.mjs'
import { OperationBackend } from './operation-backend.mjs'

export const BRIDGE_PROTOCOL_VERSION = 1
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const bridgeError = (message, code = 'bridge_unavailable') => Object.assign(new Error(message), { code })

/** Restrict the connection to the desktop-owned local IPC endpoint. No URL/TCP support. */
export async function validateEndpoint(endpoint, platform = process.platform) {
  if (typeof endpoint !== 'string' || endpoint.includes('\0')) throw new TypeError('A local socket path is required')
  if (platform === 'win32') {
    if (!/^\\\\\.\\pipe\\futureox-design-[A-Za-z0-9_-]+$/.test(endpoint)) throw new TypeError('Expected a Futureox Design Windows named pipe')
    return
  }
  if (!path.isAbsolute(endpoint)) throw new TypeError('Socket path must be absolute')
  const parent = path.dirname(endpoint)
  const [directory, socket, resolvedParent] = await Promise.all([lstat(parent), lstat(endpoint), realpath(parent)])
  if (directory.isSymbolicLink() || socket.isSymbolicLink() || resolvedParent !== path.normalize(parent)) throw new Error('Socket paths must not traverse symbolic links')
  if (!directory.isDirectory() || !socket.isSocket()) throw new Error('Expected a local socket inside a private directory')
  if ((directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) throw new Error('Socket and parent directory must be owner-private')
  if (typeof process.getuid === 'function' && (directory.uid !== process.getuid() || socket.uid !== process.getuid())) throw new Error('Socket and parent directory must belong to the current user')
}

/** Authenticated, per-session client for the desktop bridge. Tokens are never logged or persisted. */
export class SocketDesignBackend {
  constructor({ endpoint, sessionId, token, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 60000, connectTimeoutMs = 10000, transport = { validateEndpoint, createConnection: options => net.createConnection(options) } }) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new TypeError('A bridge session ID is required')
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096) throw new TypeError('An ephemeral bridge token is required')
    this.transport = transport
    this.endpoint = endpoint
    this.sessionId = sessionId
    this.token = token
    this.redact = message => message.replaceAll(token, '[redacted]')
    this.maxBytes = maxBytes
    this.timeoutMs = timeoutMs
    this.connectTimeoutMs = connectTimeoutMs
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.connection = undefined
    this.operation = undefined
    this.reader = new JsonLineReader({
      maxBytes,
      onLine: line => this.receive(line),
      onError: () => this.fail(bridgeError('Invalid or oversized bridge response', 'bridge_protocol_error')),
    })
  }

  async connect() {
    if (this.closed) throw bridgeError('Bridge connection is closed')
    if (this.operation) return this.operation
    if (!this.connection) this.connection = this.open().catch(error => { this.fail(error); throw error })
    return this.connection
  }

  async open() {
    await this.transport.validateEndpoint(this.endpoint)
    if (this.closed) throw bridgeError('Bridge connection is closed')
    const socket = this.transport.createConnection({ path: this.endpoint })
    this.socket = socket
    socket.on('data', chunk => this.reader.push(chunk))
    socket.on('error', () => this.fail(bridgeError('Could not connect to the enabled desktop bridge')))
    socket.on('end', () => this.fail(bridgeError('Desktop bridge session ended')))
    socket.on('close', () => this.fail(bridgeError('Desktop bridge session closed')))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(bridgeError('Desktop bridge connect timed out')); socket.destroy() }, this.connectTimeoutMs)
      const cleanup = () => { clearTimeout(timeout); socket.off('connect', onConnect); socket.off('error', onError); socket.off('close', onClose) }
      const onConnect = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(bridgeError('Could not connect to the enabled desktop bridge')) }
      const onClose = () => { cleanup(); reject(bridgeError('Desktop bridge closed during connection')) }
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
    let handshake
    try {
      handshake = await this.request('capabilities', { protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: this.sessionId, token: this.token })
    } finally { this.token = undefined }
    if (!isRecord(handshake) || handshake.protocolVersion !== BRIDGE_PROTOCOL_VERSION || handshake.sessionId !== this.sessionId || !['read', 'write'].includes(handshake.scope)) {
      this.fail(bridgeError('Unexpected desktop bridge handshake', 'bridge_protocol_error'))
      throw bridgeError('Unexpected desktop bridge handshake', 'bridge_protocol_error')
    }
    this.operation = new OperationBackend({
      capabilities: handshake.capabilities,
      scope: handshake.scope,
      target: typeof handshake.documentId === 'string' && Number.isSafeInteger(handshake.session) ? { documentId: handshake.documentId, session: handshake.session } : undefined,
      execute: (request, context) => this.request('execute', request, context),
    })
    return this.operation
  }

  async listTools(context) {
    if (context?.signal?.aborted) throw context.signal.reason
    return (await this.connect()).listTools(context)
  }

  async callTool(name, args, context) {
    if (context?.signal?.aborted) throw context.signal.reason
    return (await this.connect()).callTool(name, args, context)
  }

  request(method, params, { signal } = {}) {
    if (this.closed || !this.socket || this.socket.destroyed) return Promise.reject(bridgeError('Desktop bridge is not connected'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.pending.size >= 8) return Promise.reject(bridgeError('Too many outstanding bridge requests', 'bridge_busy'))
    const id = `mcp-${++this.sequence}`
    const line = JSON.stringify({ id, method, params }) + '\n'
    if (Buffer.byteLength(line) > this.maxBytes) return Promise.reject(bridgeError('Operation exceeds bridge message limit', 'request_too_large'))
    if (this.socket.writableLength + Buffer.byteLength(line) > 40 * 1024 * 1024) return Promise.reject(bridgeError('Desktop bridge output queue is full', 'bridge_busy'))
    return new Promise((resolve, reject) => {
      const cancel = reason => {
        if (!this.pending.has(id)) return
        this.finish(id)
        if (!this.socket.destroyed) this.socket.write(JSON.stringify({ method: 'cancel', params: { requestId: id } }) + '\n')
        reject(reason)
      }
      const onAbort = () => cancel(signal.reason ?? bridgeError('Operation cancelled', 'cancelled'))
      const timer = setTimeout(() => cancel(bridgeError('Design operation timed out; a dispatched mutation may have committed', 'timeout')), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.socket.write(line, error => { if (error) this.fail(bridgeError('Could not write to desktop bridge')) })
    })
  }

  finish(id) {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    this.pending.delete(id)
    return pending
  }

  receive(line) {
    let response
    try { response = JSON.parse(line) } catch { this.fail(bridgeError('Malformed desktop bridge response', 'bridge_protocol_error')); return }
    if (!isRecord(response) || typeof response.id !== 'string' || (('result' in response) === ('error' in response))) {
      this.fail(bridgeError('Invalid desktop bridge response', 'bridge_protocol_error')); return
    }
    const pending = this.finish(response.id)
    if (!pending) return // A cancelled request may have already completed at the editor.
    if ('error' in response) {
      const error = response.error
      pending.reject(bridgeError(isRecord(error) && typeof error.message === 'string' ? this.redact(error.message) : 'Desktop bridge operation failed', isRecord(error) && typeof error.code === 'string' ? this.redact(error.code) : 'bridge_error'))
    } else pending.resolve(response.result)
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    this.token = undefined
    for (const id of this.pending.keys()) this.finish(id)?.reject(error)
    this.socket?.destroy()
  }

  close() { this.fail(bridgeError('MCP session closed', 'cancelled')) }
}
