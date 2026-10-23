import type { Editor } from './engine'
import { canvasActions, CanvasAction, ActionOutcome, ActionReason, type ActionCode, type ActionSourceCode, type ActionOutcomeCode, type ActionReasonCode } from './canvas-action-diagnostics'

/** Explicit action boundary only, never pointer samples or raw arguments. UI state
 * changes are observed, not claimed as document commits or visual correctness. */
export function beginEditorAction(editor: Pick<Editor, 'state'> & Partial<Pick<Editor, 'sessionGeneration'>>, action: ActionCode, source: ActionSourceCode, commandCode = 0) {
  if (editor.sessionGeneration === undefined) return { result(_value: ActionOutcomeCode, _why: ActionReasonCode = ActionReason.none) {}, finish() {} }
  const trace = canvasActions(editor as Pick<Editor, 'state' | 'sessionGeneration'>)
  const session = editor.sessionGeneration
  const before = editor.state
  const token = trace.begin(action, source, { commandCode, selectionBefore: before.selection.length, routeSupported: true })
  let outcome: ActionOutcomeCode | undefined, reason: ActionReasonCode = ActionReason.none
  return {
    result(value: ActionOutcomeCode, why: ActionReasonCode = ActionReason.none) { outcome = value; reason = why },
    finish() {
      const after = editor.state
      const selectionChanged = before.selection.length !== after.selection.length || before.selection.some((id, index) => after.selection[index] !== id)
      const committedChanged = session === editor.sessionGeneration && (outcome === undefined || outcome === ActionOutcome.committed) && before.version !== after.version && before.doc !== after.doc
      const observed = selectionChanged || before.tool !== after.tool || before.page !== after.page || before.view !== after.view || before.renamingLayer !== after.renamingLayer
      trace.finish(token, outcome ?? (committedChanged ? ActionOutcome.committed : observed ? ActionOutcome.observed : ActionOutcome.unchanged), outcome === undefined && !committedChanged && !observed ? ActionReason.unobserved : reason,
        { selectionAfter: after.selection.length, selectionChanged, committedChanged })
      // An intentional adoption closes the old session; report verified success
      // separately in the new session, never label a stale async mutation committed.
      if (session !== editor.sessionGeneration && outcome === ActionOutcome.observed &&
        (action === CanvasAction.import || action === CanvasAction.newDocument || action === CanvasAction.save))
        trace.event(action, source, ActionOutcome.observed, ActionReason.none, { commandCode, selectionAfter: after.selection.length })
    },
  }
}
