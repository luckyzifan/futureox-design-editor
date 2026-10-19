import type { Readable, Writable } from 'node:stream'
import type { BackendContext, ToolDefinition } from './operation-backend.mjs'
export declare const PROTOCOL_VERSION: '2025-11-25'
export declare const SERVER_INFO: Readonly<{ name: string; version: string; title: string }>
export declare const DEFAULT_LIMITS: Readonly<Record<string, number>>
export declare class ProtocolError extends Error { constructor(code: number, message: string, data?: unknown); code: number; data?: unknown }
export interface DesignBackend {
  listTools(context?: BackendContext): ToolDefinition[] | Promise<ToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>, context?: BackendContext): unknown | Promise<unknown>
  close?(): void | Promise<void>
}
export declare class DesignMcpServer {
  constructor(options: { backend: DesignBackend; input?: Readable; output?: Writable; diagnostics?: Writable; limits?: Record<string, number> })
  start(): this
  close(): Promise<void>
  done: Promise<void>
}
