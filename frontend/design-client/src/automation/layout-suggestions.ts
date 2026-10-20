import { previewLayoutSuggestion, applyLayoutSuggestion } from '../layout-suggestions'
import { AutomationError, type AutomationExtension } from './types'
const frameId = { type: 'string', minLength: 1, maxLength: 128 }
export const layoutSuggestionExtensions: AutomationExtension[] = [
  { name: 'layout.suggest', mutates: false, description: 'Preview deterministic geometry-preserving row, column, grid/wrap choices and existing nested frames. No document, history or selection mutations. Inspects at most 1000 nodes; irregular or unsafe geometry is declined. Returns confidence, explanation, exceptions and a freshness fingerprint.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['frameId'], properties: { frameId } },
    execute(doc, p) { try { return previewLayoutSuggestion(doc, p.frameId as string) } catch (e) { throw new AutomationError('layout_suggestion_rejected', String(e)) } },
  },
  { name: 'layout.applySuggestion', mutates: true, description: 'Explicitly apply a named layout.suggest candidate. Requires its unchanged fingerprint and the dispatcher expectedRevision/session. Recomputes patches; stale/forged suggestions fail atomically. Uses normal native layout and one undo transaction; serializes as ordinary FD layout.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['frameId', 'fingerprint', 'suggestionId'], properties: { frameId, fingerprint: { type: 'string', minLength: 64, maxLength: 64 }, suggestionId: { type: 'string', enum: ['preserve-geometry', 'wrapped-rows'] } } },
    execute(doc, p) { try { return { changedFrameIds: applyLayoutSuggestion(doc, p.frameId as string, p.fingerprint as string, p.suggestionId as string) } } catch (e) { throw new AutomationError('layout_suggestion_rejected', String(e)) } },
  },
]
