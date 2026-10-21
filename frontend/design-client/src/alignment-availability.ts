import type { Editor } from './engine'
import { selectionCommandAdmission } from './commands/selection-command'
import { commitPendingEdits } from './pending-edits'

/** The toolbar and Inspector expose the same existing parent/selection alignment contract. */
export function alignmentAvailability(editor: Editor) {
  const { doc, busy, selection } = editor.state, parents = editor.parentMap()
  const available = !busy && !editor.interactionActive
  return {
    align: available && selectionCommandAdmission(doc, selection, 'align', parents).ok,
    distribute: available && selectionCommandAdmission(doc, selection, 'distribute', parents).ok,
  }
}
export function alignSelection(editor: Editor, axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute') {
  if (!commitPendingEdits(editor)) return
  if (!alignmentAvailability(editor)[mode === 'distribute' ? 'distribute' : 'align']) return
  editor.align(axis, mode)
}
