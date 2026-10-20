import type { Editor } from './engine'
import { canvasActions, CanvasAction, ActionSource, ActionOutcome, ActionReason, type ActionCode, type ActionFields, type ActionReasonCode } from './canvas-action-diagnostics'
export { canvasActions, CanvasAction, ActionSource, ActionOutcome, ActionReason }
/** Private snapshots never enter the diagnostic sink. Only bounded semantic observations do. */
export function utilityAction(editor: Editor, code: ActionCode, source = ActionSource.pointer as number, fields: ActionFields = {}) {
  const trace = canvasActions(editor), version = editor.state.version, session = editor.sessionGeneration
  const token = trace.begin(code, source as typeof ActionSource.pointer, fields)
  let ended = false
  return {
    sample: (fields: ActionFields = {}) => trace.sample(token, fields),
    finish: (observed = false, fields: ActionFields = {}) => {
      if (ended) return; ended = true
      const changed = session === editor.sessionGeneration && editor.state.version > version
      trace.finish(token, changed ? ActionOutcome.committed : observed ? ActionOutcome.observed : ActionOutcome.unchanged, ActionReason.none, { committedChanged: changed, ...fields })
    },
    block: (reason: ActionReasonCode = ActionReason.noTarget, fields: ActionFields = {}) => { if (ended) return; ended = true; trace.finish(token, ActionOutcome.blocked, reason, fields) },
    cancel: (reason: ActionReasonCode = ActionReason.pointerCancel) => { if (ended) return; ended = true; trace.finish(token, ActionOutcome.cancelled, reason) },
  }
}
export type UtilityAction = ReturnType<typeof utilityAction>
/** Synchronous semantic route: handler completion alone never becomes a commit. */
export function runUtilityAction(editor: Editor, code: ActionCode, source: number, run: () => void, observed = false) {
  const action = utilityAction(editor, code, source)
  try { run(); action.finish(observed) } catch (error) { action.cancel(ActionReason.validation); throw error }
}
