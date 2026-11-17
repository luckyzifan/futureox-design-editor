import type { Editor } from './engine'
import { selectionCommandAdmission } from './commands/selection-command'
import { commitPendingEdits } from './pending-edits'
import { arrangePatches } from './align-engine'
import { interactivePath } from './selection-hierarchy'

export const alignmentCommands = {
  'align-left': { axis: 'x', mode: 'start', label: ['左对齐', 'Align Left'] },
  'align-horizontal-center': { axis: 'x', mode: 'center', label: ['水平居中', 'Align Horizontal Center'] },
  'align-right': { axis: 'x', mode: 'end', label: ['右对齐', 'Align Right'] },
  'align-top': { axis: 'y', mode: 'start', label: ['顶部对齐', 'Align Top'] },
  'align-vertical-center': { axis: 'y', mode: 'center', label: ['垂直居中', 'Align Vertical Center'] },
  'align-bottom': { axis: 'y', mode: 'end', label: ['底部对齐', 'Align Bottom'] },
} as const
export type AlignmentCommand = keyof typeof alignmentCommands
export const alignmentCommandIds = Object.keys(alignmentCommands) as AlignmentCommand[]
export function isAlignmentCommand(command: string): command is AlignmentCommand {
  return Object.hasOwn(alignmentCommands, command)
}

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

export function canTidySelection(editor: Editor, distribute = alignmentAvailability(editor).distribute) {
  const { doc, page, selection } = editor.state
  const parents = editor.parentMap(doc)
  return distribute && selection.every(id => !doc.nodes[id]?.instanceOrigin &&
    interactivePath(doc, page, id, false, parents).length > 0)
}

function tidyPatches(editor: Editor) {
  const { doc, page, selection } = editor.state
  return canTidySelection(editor) ? arrangePatches(doc, page, selection, 'tidy') : null
}

export function previewTidy(editor: Editor) {
  const patches = tidyPatches(editor)
  const { doc, page, selection } = editor.state
  editor.setLiveArrangement(patches ? { document: doc, page, selection, session: editor.sessionGeneration, patches } : null)
}

export function tidySelection(editor: Editor) {
  editor.setLiveArrangement(null)
  if (!commitPendingEdits(editor)) return
  const patches = tidyPatches(editor)
  if (patches) editor.change('整理图层', draft => {
    for (const [id, patch] of Object.entries(patches)) draft.nodes[id].transform = patch.transform
  })
}
