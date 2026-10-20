import type { DesignDocument } from '../model'

/** Serializable public boundary. The document version and session fence are
 * distinct: opening a different file invalidates a previously issued request. */
export interface AutomationRequest {
  id?: string | number
  method: string
  params?: Record<string, unknown>
  expectedRevision?: number
  documentId?: string
  session?: number
}
export interface AutomationContext {
  pageId: string
  selection: string[]
  createdIds: string[]
  revision?: number
  session?: number
}
export interface AutomationMethod {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates: boolean
}
/** Extensions are trusted application code, never script supplied by a caller.
 * A mutating extension edits only its supplied isolated draft in place. */
export interface AutomationExtension extends AutomationMethod {
  /** Trusted syntax-only expansion. Must be synchronous and side-effect free.
   * Dispatcher schema-checks and authorizes each leaf; recursive expansion is rejected. */
  expand?(params: Record<string, unknown>): { method: string; params?: Record<string, unknown> }[]
  execute(document: DesignDocument, params: Record<string, unknown>, context: AutomationContext): unknown
}
export interface AutomationCapabilities {
  version: 1
  methods: AutomationMethod[]
  limits: { maxBatchOperations: number; maxRequestBytes: number; defaultMaxRequestBytes?: number; maxQueryResults: number }
  editing?: Record<string, unknown>
  unsupported: string[]
}
/** Additive output only on interrupted/superseded publication. This reports
 * prior facts, never a callable receipt or permission to replay a mutation. */
export type AutomationMutationCompletion = {
  documentId: string; session: number; revision: number
  superseded: true; contextApplied: false
} & ({ status: 'committed'; retry: 'do-not-retry' } | { status: 'unchanged'; retry: 'read-current-state' })
export const automationMutationCompletionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    documentId: { type: 'string', minLength: 1 }, session: { type: 'integer', minimum: 0 }, revision: { type: 'integer', minimum: 0 },
    superseded: { const: true }, contextApplied: { const: false },
    status: { enum: ['committed', 'unchanged'] }, retry: { enum: ['do-not-retry', 'read-current-state'] },
  },
  required: ['documentId', 'session', 'revision', 'superseded', 'contextApplied', 'status', 'retry'],
  oneOf: [
    { properties: { status: { const: 'committed' }, retry: { const: 'do-not-retry' } } },
    { properties: { status: { const: 'unchanged' }, retry: { const: 'read-current-state' } } },
  ],
} as const
export interface AutomationFailure {
  code: string
  message: string
  details?: unknown
}
type ResponseBase = {
  id?: string | number
  method: string
  documentId: string
  revision: number
  session: number
}
export type AutomationResponse =
  | (ResponseBase & { ok: true; result: unknown })
  | (ResponseBase & { ok: false; error: AutomationFailure })
export class AutomationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'AutomationError'
  }
}
