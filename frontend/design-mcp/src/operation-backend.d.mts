export interface BackendContext { signal?: AbortSignal; requestId?: string | number }
export interface OperationRequest { id?: string | number; method: string; params?: Record<string, unknown>; expectedRevision?: number; documentId?: string; session?: number }
export interface OperationMethod { name: string; description: string; inputSchema: Record<string, unknown>; mutates: boolean }
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }
export declare class OperationBackend {
  constructor(options: { capabilities: { version: number; methods: OperationMethod[] }; execute: (request: OperationRequest, context: BackendContext) => unknown | Promise<unknown>; close?: () => void | Promise<void>; scope?: 'read' | 'write'; target?: { documentId: string; session: number } })
  listTools(): ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>, context?: BackendContext): Promise<unknown>
  close(): void | Promise<void>
}
