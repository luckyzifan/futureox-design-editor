import type { Editor } from './engine'
import { allParents } from './geometry'
import { interactivePath } from './selection-hierarchy'
import { commitPendingEdits } from './pending-edits'

/** The toolbar and Inspector expose the same existing parent/selection alignment contract. */
export function alignmentAvailability(editor: Editor) {
  const { doc, page, busy } = editor.state, parents = allParents(doc)
  const ids = editor.topSelection().filter(id => interactivePath(doc, page, id, false, parents).length)
  const available = !busy && !editor.interactionActive
  return {
    align: available && (ids.length > 1 || (ids.length === 1 && !!doc.nodes[parents.get(ids[0]) || ''])),
    distribute: available && ids.length >= 3,
  }
}
export function alignSelection(editor: Editor, axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute') {
  if (!commitPendingEdits(editor)) return
  if (!alignmentAvailability(editor)[mode === 'distribute' ? 'distribute' : 'align']) return
  editor.align(axis, mode)
}
