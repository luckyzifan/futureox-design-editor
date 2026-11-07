import type { Editor } from '../engine'
import { createEditorDesignAutomation } from '../automation'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'

export type AgentOperation = { method: string; params: Record<string, unknown> }

/** Submit an agent batch through the MCP operation backend into the live editor. */
export async function applyAgentOperations(editor: Editor, operations: AgentOperation[], label: string, mutationId: string) {
  if (!operations.length) return { ok: true as const, result: { skipped: true } }
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({
    capabilities: api.capabilities(),
    execute: (request: unknown) => api.execute(request as Parameters<typeof api.execute>[0]),
  })
  return backend.callTool('design_batch_apply', {
    documentId: editor.state.doc.id,
    session: editor.sessionGeneration,
    expectedRevision: editor.state.version,
    params: { operations, label: label.slice(0, 200), mutationId },
  })
}
