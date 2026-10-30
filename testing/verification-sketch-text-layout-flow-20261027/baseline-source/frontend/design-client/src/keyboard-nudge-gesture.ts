import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import type { Editor } from './engine'
import { commitPendingEdits, pendingEditsChanged, registerPendingEdit } from './pending-edits'

const owners = new WeakMap<Editor, { active: boolean }>()
export function keyboardNudgeActive(editor: Editor) { return !!owners.get(editor)?.active }
/** Let the App capture boundary preserve this already-owned held-key edit.
 * The caller must use the same editable/modal guard as Canvas keyboard routing. */
export function keyboardNudgeOwnsKey(editor: Editor, event: Pick<KeyboardEvent, 'key'>) {
  return keyboardNudgeActive(editor) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Shift', 'Control', 'Meta', 'Alt'].includes(event.key)
}

/** Owns only keyboard-nudge transactions. Pointer gestures and unrelated taps
 * are never coalesced. No idle timer can silently split a held key. */
export function createKeyboardNudgeGesture(editor: Editor) {
  const owner = { active: false }; owners.set(editor, owner)
  let active: { key: string; session: number; document: string; context: string; trace: ReturnType<typeof beginEditorAction> } | null = null
  const context = () => JSON.stringify([editor.state.page, editor.state.selection, editor.state.tool, editor.state.editingVertex, editor.state.editingVertices])
  const finish = (cancel = false) => {
    const previous = active
    if (!previous) return false
    active = null; owner.active = false
    if (previous.session === editor.sessionGeneration && previous.document === editor.state.doc.id && editor.interactionActive) {
      if (cancel) editor.cancel(); else editor.commit()
    }
    if (cancel) previous.trace.result(ActionOutcome.cancelled, ActionReason.escape)
    previous.trace.finish()
    pendingEditsChanged(editor)
    return true
  }
  const stopPending = registerPendingEdit(editor, { dirty: () => !!active, commit: () => { finish(); return true } })
  const stopEditor = editor.subscribe(() => {
    if (!active) return
    if (!editor.interactionActive || active.session !== editor.sessionGeneration || active.document !== editor.state.doc.id) { const previous = active; active = null; owner.active = false; previous.trace.result(ActionOutcome.cancelled, ActionReason.superseded); previous.trace.finish(); pendingEditsChanged(editor) }
    else if (active.context !== context() || editor.state.busy) finish()
  })
  return {
    get active() { return !!active },
    step(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>, label: string, mutate: () => void) {
      if (active && (!event.repeat || active.key !== event.key)) finish()
      if (!active) {
        if (event.repeat) return
        if (editor.state.busy || editor.interactionActive || !commitPendingEdits(editor)) return
        active = { key: event.key, session: editor.sessionGeneration, document: editor.state.doc.id, context: context(), trace: beginEditorAction(editor, CanvasAction.move, ActionSource.keyboard, 320) }
        owner.active = true
        editor.begin(label); pendingEditsChanged(editor)
      }
      mutate()
    },
    release(key: string) { if (active?.key === key) finish() },
    finish,
    dispose() { finish(); stopEditor(); stopPending(); if (owners.get(editor) === owner) owners.delete(editor) },
  }
}
