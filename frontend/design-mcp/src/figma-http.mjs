import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { DesignMcpServer } from './server.mjs'
import { FIGMA_MCP_INSTRUCTIONS, FigmaFacade } from './figma-facade.mjs'
import { SocketDesignBackend } from './socket-backend.mjs'
import { parseOptions } from './cli.mjs'

const MAX_BODY = 1024 * 1024

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
    this.backend = backend
    this.queue = Promise.resolve()
    this.open()
  }

  open() {
    this.input = new PassThrough()
    this.output = new PassThrough()
    this.buffer = ''
    this.pending = new Map()
    this.server = new DesignMcpServer({
      backend: this.backend, input: this.input, output: this.output, diagnostics: { write() {} }, instructions: FIGMA_MCP_INSTRUCTIONS,
    }).start()
    this.output.on('data', chunk => this.receive(chunk))
  }

  receive(chunk) {
    this.buffer += chunk.toString('utf8')
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter.resolve(message)
      }
    }
  }

  handle(message) {
    const run = this.queue.then(() => this.dispatch(message))
    this.queue = run.then(() => {}, () => {})
    return run
  }

  async dispatch(message) {
    if (message.method === 'initialize' && this.server.phase !== 'new') {
      await this.server.close()
      this.input.destroy()
      this.output.destroy()
      this.open()
    }
    if (!Object.hasOwn(message, 'id')) {
      this.input.write(`${JSON.stringify(message)}\n`)
      return { status: 202 }
    }
    let rejectWait
    const body = new Promise((resolve, reject) => {
      rejectWait = reject
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(Object.assign(new Error('MCP response timed out'), { code: 'timeout' }))
      }, 60000)
      timer.unref?.()
      this.pending.set(message.id, { resolve: value => { clearTimeout(timer); resolve(value) } })
    })
    if (!this.input.write(`${JSON.stringify(message)}\n`)) rejectWait(Object.assign(new Error('MCP session is not accepting input'), { code: 'closed' }))
    return { status: 200, body: await body }
  }

  async close() {
    await this.server.close()
    this.input.destroy()
    this.output.destroy()
  }
}

async function facadeFromSocket({ endpoint, sessionId, token, connectTimeoutMs }) {
  const socket = new SocketDesignBackend({ endpoint, sessionId, token, connectTimeoutMs })
  const operation = await socket.connect()
  const facade = new FigmaFacade({
    execute: (request, context) => operation.execute(request, context),
    methods: operation.capabilities.methods,
    scope: operation.scope,
    target: operation.target,
    terminalSignal: socket.terminalSignal,
  })
  return { facade, close: () => socket.close() }
}

/** Loopback streamable-HTTP endpoint. One MCP session, JSON responses, no SSE.
 * Bind address must be a loopback host. The bearer token is the desktop bridge token. */
export async function startLoopbackFigmaMcp({ endpoint, sessionId, token, backend, host = '127.0.0.1', port = 0, connectTimeoutMs = 10000 } = {}) {
  if (host !== '127.0.0.1' && host !== '::1') throw new TypeError('Figma MCP HTTP listens on loopback only')
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('An ephemeral bridge token is required')
  const owned = backend ? null : await facadeFromSocket({ endpoint, sessionId, token, connectTimeoutMs })
  const session = new HttpMcpSession(backend ?? owned.facade)
  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress
    if (!loopbackAddressAllowed(remote)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Loopback clients only' } }))
      return
    }
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }))
      return
    }
    if (request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } }))
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'POST JSON-RPC to this URL. Server-sent events are not implemented.' } }))
      return
    }
    const chunks = []
    let bytes = 0
    let failed = false
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        failed = true
        response.writeHead(413, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Request body exceeds 1 MiB' } }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed || response.writableEnded) return
      let message
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }))
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected one JSON-RPC object' } }))
        return
      }
      session.handle(message).then(result => {
        if (response.writableEnded) return
        if (result.status === 202) {
          response.writeHead(202)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.body))
      }, () => {
        if (response.writableEnded) return
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'MCP session failed' } }))
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    port: boundPort,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await session.close()
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
