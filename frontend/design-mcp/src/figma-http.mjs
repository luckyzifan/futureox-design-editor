import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { DesignMcpServer, PROTOCOL_VERSION } from './server.mjs'
import { FIGMA_ASSET_LIMIT, FIGMA_MCP_INSTRUCTIONS, FigmaFacade } from './figma-facade.mjs'
import { MODERN_PROTOCOL_VERSION } from './modern-protocol.mjs'
import { SocketDesignBackend } from './socket-backend.mjs'
import { parseOptions } from './cli.mjs'
import { isRequestId } from './framing.mjs'

const MAX_BODY = 1024 * 1024
const MAX_SESSIONS = 8
const MAX_PENDING_REQUESTS = 32
const SESSION_IDLE_MS = 30 * 60 * 1000

export function loopbackAddressAllowed(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function authorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

class HttpMcpSession {
  constructor(backend) {
    this.input = new PassThrough()
    this.output = new PassThrough()
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.pending = new Map()
    this.lastUsed = Date.now()
    this.closed = false
    this.server = new DesignMcpServer({
      // The desktop grant owns the shared socket. Ending one client session
      // only retires that client's request IDs, work and resources.
      backend, input: this.input, output: this.output, diagnostics: { write() {} },
      instructions: FIGMA_MCP_INSTRUCTIONS, artifactCount: FIGMA_ASSET_LIMIT,
    }).start()
    this.output.on('data', chunk => this.receive(chunk))
  }

  receive(chunk) {
    this.buffer += this.decoder.write(chunk)
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      this.pending.get(message.id)?.finish({ status: 200, body: message })
    }
  }

  dispatch(message) {
    if (this.closed || this.server.closed) return { status: 404, body: rpcError(-32000, 'MCP session not found') }
    this.lastUsed = Date.now()
    if (!Object.hasOwn(message, 'id')) {
      this.input.write(`${JSON.stringify(message)}\n`)
      if (message.method === 'notifications/cancelled') {
        const cancelled = this.pending.get(message.params?.requestId)
        if (cancelled && cancelled.method !== 'initialize') cancelled.finish({ status: 202 })
      }
      return { status: 202 }
    }
    if (this.pending.has(message.id)) return { status: 400, body: rpcError(-32600, 'Request ID is already outstanding', message.id) }
    if (this.pending.size >= MAX_PENDING_REQUESTS) return { status: 429, body: rpcError(-32000, 'Too many HTTP requests', message.id) }
    return new Promise(resolve => {
      const finish = result => {
        clearTimeout(timer)
        this.pending.delete(message.id)
        this.lastUsed = Date.now()
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish({ status: 504, body: rpcError(-32000, 'MCP response timed out. A dispatched mutation may already have completed.', message.id) })
      }, this.server.limits.requestTimeoutMs + 1000)
      timer.unref?.()
      this.pending.set(message.id, { method: message.method, finish })
      this.input.write(`${JSON.stringify(message)}\n`)
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) waiter.finish({ status: 404 })
    await this.server.close()
    this.input.destroy()
    this.output.destroy()
  }
}

function rpcError(code, message, id = null) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function respond(response, status, body, headers = {}) {
  if (response.writableEnded || response.destroyed) return
  response.writeHead(status, body === undefined ? headers : { ...headers, 'content-type': 'application/json' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

async function facadeFromSocket({ endpoint, sessionId, token, connectTimeoutMs }) {
  const socket = new SocketDesignBackend({ endpoint, sessionId, token, connectTimeoutMs })
  const operation = await socket.connect()
  const facade = new FigmaFacade({
    execute: (request, context) => operation.execute(request, context),
    methods: [...operation.methods.values()],
    scope: operation.scope,
    target: operation.target,
    terminalSignal: socket.terminalSignal,
  })
  return { facade, close: () => socket.close() }
}

/** Loopback Streamable HTTP using JSON responses and per-client MCP sessions.
 * Bind address must be a loopback host. The bearer token is the desktop bridge token. */
export async function startLoopbackFigmaMcp({ endpoint, sessionId, token, backend, host = '127.0.0.1', port = 0, connectTimeoutMs = 10000 } = {}) {
  if (host !== '127.0.0.1' && host !== '::1') throw new TypeError('Figma MCP HTTP listens on loopback only')
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('An ephemeral bridge token is required')
  const urlHost = host === '::1' ? '[::1]' : host
  const owned = backend ? null : await facadeFromSocket({ endpoint, sessionId, token, connectTimeoutMs })
  const source = backend ?? owned.facade
  const sharedBackend = {
    listTools: (...args) => source.listTools(...args),
    callTool: (...args) => source.callTool(...args),
    terminalSignal: source.terminalSignal,
  }
  const sessions = new Map()
  let closing = false
  function retire(id, session) {
    if (sessions.get(id) === session) sessions.delete(id)
    return session.close()
  }
  function expireSessions() {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (!session.pending.size && now - session.lastUsed > SESSION_IDLE_MS) void retire(id, session)
    }
  }
  const revoke = () => {
    for (const [id, session] of sessions) void retire(id, session)
  }
  sharedBackend.terminalSignal?.addEventListener('abort', revoke, { once: true })
  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress
    if (!loopbackAddressAllowed(remote)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Loopback clients only' } }))
      return
    }
    const origin = request.headers.origin
    if (origin !== undefined && origin !== new URL(`http://${urlHost}:${request.socket.localPort}`).origin) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Origin is not allowed' } }))
      return
    }
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }))
      return
    }
    if (request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } }))
      return
    }
    const protocolVersion = request.headers['mcp-protocol-version']
    if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION && protocolVersion !== MODERN_PROTOCOL_VERSION) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported MCP-Protocol-Version' } }))
      return
    }
    if (closing || sharedBackend.terminalSignal?.aborted) {
      respond(response, 404, rpcError(-32000, 'The desktop authorization has ended'))
      return
    }
    expireSessions()
    const id = request.headers['mcp-session-id']
    const existing = sessions.get(id)
    if (id !== undefined && !existing) {
      respond(response, 404, rpcError(-32000, 'MCP session not found'))
      return
    }
    if (existing && protocolVersion !== undefined && protocolVersion !== existing.protocolVersion) {
      respond(response, 400, rpcError(-32600, 'Protocol version does not match this session'))
      return
    }
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      respond(response, 405, rpcError(-32601, 'Use POST for JSON-RPC. This endpoint does not offer an event stream.'), { allow: 'POST, DELETE' })
      return
    }
    if (request.method === 'DELETE') {
      if (!existing) respond(response, 400, rpcError(-32600, 'MCP-Session-Id is required'))
      else void retire(id, existing).then(() => respond(response, 204))
      return
    }
    const chunks = []
    let bytes = 0
    let failed = false
    request.on('data', chunk => {
      if (failed) return
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        failed = true
        chunks.length = 0
        respond(response, 413, rpcError(-32000, 'Request body exceeds 1 MiB'), { connection: 'close' })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', async () => {
      if (failed || response.writableEnded) return
      let message
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }))
        return
      }
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || Object.hasOwn(message, 'id') && !isRequestId(message.id)) {
        respond(response, 400, rpcError(-32600, 'Expected one JSON-RPC request or notification'))
        return
      }
      if (existing) {
        if (message.method === 'initialize') {
          respond(response, 400, rpcError(-32600, 'Initialize without an MCP-Session-Id', message.id))
          return
        }
        const result = await existing.dispatch(message)
        respond(response, result.status, result.body)
        return
      }
      if (message.method !== 'initialize' || !Object.hasOwn(message, 'id')) {
        respond(response, 400, rpcError(-32600, 'MCP-Session-Id is required', message.id))
        return
      }
      if (closing || sharedBackend.terminalSignal?.aborted) {
        respond(response, 404, rpcError(-32000, 'The desktop authorization has ended'))
        return
      }
      if (sessions.size >= MAX_SESSIONS) {
        respond(response, 429, rpcError(-32000, 'HTTP session limit reached; end an unused session', message.id))
        return
      }
      const clientId = randomUUID()
      const session = new HttpMcpSession(sharedBackend)
      sessions.set(clientId, session)
      void session.server.done.then(() => retire(clientId, session))
      const result = await session.dispatch(message)
      const negotiated = result.body?.result?.protocolVersion
      if (typeof negotiated === 'string' && sessions.has(clientId) && !response.destroyed) {
        session.protocolVersion = negotiated
        respond(response, result.status, result.body, { 'mcp-session-id': clientId })
      } else {
        await retire(clientId, session)
        respond(response, result.status, result.body)
      }
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.off('error', reject); resolve() })
    })
  } catch (error) {
    sharedBackend.terminalSignal?.removeEventListener('abort', revoke)
    await owned?.close()
    throw error
  }
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  return {
    url: `http://${urlHost}:${boundPort}/mcp`,
    port: boundPort,
    close: async () => {
      closing = true
      sharedBackend.terminalSignal?.removeEventListener('abort', revoke)
      await Promise.all([...sessions].map(([id, session]) => retire(id, session)))
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
      await owned?.close()
    },
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (options.help) {
    process.stderr.write('Futureox Design Figma-shaped MCP (loopback HTTP)\nUsage: node src/figma-http.mjs --socket ABSOLUTE_SOCKET_PATH --session SESSION_ID\nToken: FUTUREOX_DESIGN_BRIDGE_TOKEN. The URL is printed to stderr. Clients send Authorization: Bearer <token>.\nThe desktop app starts this listener when local automation is enabled. Use this command when that listener is unavailable.\n')
    return
  }
  const server = await startLoopbackFigmaMcp({ endpoint: options.endpoint, sessionId: options.sessionId, token: options.token })
  process.stderr.write(`Futureox Figma MCP listening on ${server.url}\nSend Authorization: Bearer with FUTUREOX_DESIGN_BRIDGE_TOKEN. The token is not printed.\n`)
  await new Promise(resolve => {
    const stop = () => { void server.close().then(resolve) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`[futureox-figma-mcp] ${error.message}\n`); process.exitCode = 1 })
}
