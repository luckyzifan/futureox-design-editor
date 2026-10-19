import { isRecord } from './framing.mjs'

const GUARDS = {
  documentId: { type: 'string', minLength: 1, description: 'Document ID returned by the preceding read operation.' },
  session: { type: 'integer', minimum: 0, description: 'Editor session generation returned by the preceding read operation.' },
  expectedRevision: { type: 'integer', minimum: 0, description: 'Document revision returned by the preceding read operation.' },
}

/** Converts the real shared API capabilities to MCP tools; never implements design operations. */
export class OperationBackend {
  constructor({ capabilities, execute, close, scope = 'write', target }) {
    if (!isRecord(capabilities) || capabilities.version !== 1 || !Array.isArray(capabilities.methods) || capabilities.methods.length > 512 || typeof execute !== 'function') {
      throw new TypeError('Invalid shared design operation backend')
    }
    this.execute = execute
    this.closeBackend = close
    this.capabilities = capabilities
    this.target = target
    this.methods = new Map()
    this.tools = []
    for (const method of capabilities.methods) {
      if (!isRecord(method) || typeof method.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,110}$/.test(method.name) ||
        typeof method.description !== 'string' || typeof method.mutates !== 'boolean' || !isRecord(method.inputSchema) || method.inputSchema.type !== 'object') {
        throw new TypeError('Invalid shared design method descriptor')
      }
      if (scope === 'read' && method.mutates) continue
      const name = `design_${method.name.replaceAll('.', '_').replaceAll('-', '_')}`
      if (this.methods.has(name)) throw new TypeError('Design method names collide after MCP normalization')
      this.methods.set(name, method)
      this.tools.push({
        name,
        description: `${method.description}${method.mutates ? ' Requires current documentId, session and expectedRevision. Read state first. Cancellation cannot undo a committed operation.' : ''}`,
        inputSchema: {
          type: 'object',
          properties: { params: method.inputSchema, ...GUARDS },
          required: method.mutates ? ['documentId', 'session', 'expectedRevision'] : [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: !method.mutates, destructiveHint: method.mutates, idempotentHint: !method.mutates, openWorldHint: false },
      })
    }
  }

  listTools() { return this.tools }

  async callTool(name, args, context = {}) {
    const method = this.methods.get(name)
    if (!method) throw Object.assign(new Error('Unknown design tool'), { code: 'unsupported_method' })
    const invalid = message => ({ ok: false, method: method.name, error: { code: 'invalid_params', message } })
    if (!isRecord(args) || Object.keys(args).some(key => !['params', 'documentId', 'session', 'expectedRevision'].includes(key))) return invalid('Use params and optional documentId/session/expectedRevision guards only')
    if (args.params !== undefined && !isRecord(args.params)) return invalid('params must be an object')
    if (args.documentId !== undefined && (typeof args.documentId !== 'string' || !args.documentId)) return invalid('documentId must be a nonempty string')
    for (const key of ['session', 'expectedRevision']) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0)) return invalid(`${key} must be a nonnegative safe integer`)
    }
    if (method.mutates && ['documentId', 'session', 'expectedRevision'].some(key => args[key] === undefined)) {
      return invalid('Mutating tools require documentId, session and expectedRevision from a current read')
    }
    if (context.signal?.aborted) throw context.signal.reason
    return this.execute({
      ...(context.requestId === undefined ? {} : { id: context.requestId }),
      method: method.name,
      params: args.params ?? {},
      ...(this.target ? { documentId: this.target.documentId, session: this.target.session } : {}),
      ...Object.fromEntries(['documentId', 'session', 'expectedRevision'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
    }, context)
  }

  close() { return this.closeBackend?.() }
}
