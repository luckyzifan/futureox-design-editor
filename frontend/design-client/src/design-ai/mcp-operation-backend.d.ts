declare module '../../../design-mcp/src/operation-backend.mjs' {
  export class OperationBackend {
    constructor(options: { capabilities: unknown; execute: (request: unknown, context?: unknown) => unknown })
    callTool(name: string, args: Record<string, unknown>, context?: { signal?: AbortSignal; requestId?: string }): Promise<{
      ok: boolean
      result?: unknown
      error?: { code?: string; message?: string }
    }>
  }
}
