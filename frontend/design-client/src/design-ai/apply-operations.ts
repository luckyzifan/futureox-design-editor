import type { Editor } from '../engine'
import { createEditorDesignAutomation } from '../automation'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'

export type AgentOperation = { method: string; params: Record<string, unknown> }

export type AgentApplyResult = {
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

function isAgentApplyResult(value: unknown): value is AgentApplyResult {
  if (!value || typeof value !== 'object') return false
  const record = value as { ok?: unknown; error?: unknown }
  if (typeof record.ok !== 'boolean') return false
  if (record.error === undefined) return true
  if (!record.error || typeof record.error !== 'object') return false
  const error = record.error as { code?: unknown; message?: unknown }
  return (error.code === undefined || typeof error.code === 'string')
    && (error.message === undefined || typeof error.message === 'string')
}

/** Submit an agent batch through the MCP operation backend into the live editor. */
export async function applyAgentOperations(editor: Editor, operations: AgentOperation[], label: string, mutationId: string): Promise<AgentApplyResult> {
  if (!operations.length) return { ok: true, result: { skipped: true } }
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({
    capabilities: api.capabilities(),
    execute: (request: unknown) => api.execute(request as Parameters<typeof api.execute>[0]),
  })
  const value = await backend.callTool('design_batch_apply', {
    documentId: editor.state.doc.id,
    session: editor.sessionGeneration,
    expectedRevision: editor.state.version,
    params: { operations, label: label.slice(0, 200), mutationId },
  })
  if (!isAgentApplyResult(value)) {
    return { ok: false, error: { code: 'invalid_result', message: '设计操作没有返回可识别的结果' } }
  }
  return value
}
