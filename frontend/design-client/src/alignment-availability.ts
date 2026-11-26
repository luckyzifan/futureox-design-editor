import type { Editor } from './engine'
import { SelectionCommandError, selectionCommandAdmission } from './commands/selection-command'
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
  'distribute-horizontal': { axis: 'x', mode: 'distribute', label: ['水平分布', 'Distribute Horizontally'] },
  'distribute-vertical': { axis: 'y', mode: 'distribute', label: ['垂直分布', 'Distribute Vertically'] },
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
export function alignSelection(editor: Editor, axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute', toTopLevelFrame = false) {
  editor.setLiveArrangement(null)
  if (!commitPendingEdits(editor)) return
  if (!toTopLevelFrame && !alignmentAvailability(editor)[mode === 'distribute' ? 'distribute' : 'align']) return
  editor.align(axis, mode, toTopLevelFrame)
}

export function canTidySelection(editor: Editor) {
  const { doc, page, selection, busy } = editor.state
  if (busy || editor.interactionActive) return false
  const parents = editor.parentMap(doc)
  return selectionCommandAdmission(doc, selection, 'tidy', parents).ok && selection.every(id => !doc.nodes[id]?.instanceOrigin &&
    interactivePath(doc, page, id, false, parents).length > 0)
}

function tidyPatches(editor: Editor) {
  const { doc, page, selection } = editor.state
  return canTidySelection(editor) ? arrangePatches(doc, page, selection, 'tidy') : null
}

export function previewTidy(editor: Editor) {
  showArrangementPreview(editor, tidyPatches(editor))
}

function showArrangementPreview(editor: Editor, patches: NonNullable<Editor['liveArrangement']>['patches'] | null) {
  const { doc, page, selection, alignmentReference } = editor.state
  editor.setLiveArrangement(patches && Object.keys(patches).length ? {
    document: doc, page, selection, reference: alignmentReference, session: editor.sessionGeneration, patches,
  } : null)
}

export function previewAlignment(editor: Editor, axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute', toTopLevelFrame = false) {
  if (!alignmentAvailability(editor)[mode === 'distribute' ? 'distribute' : 'align']) {
    editor.setLiveArrangement(null)
    return
  }
  try {
    const plan = editor.selectionAlignmentPlan(axis, mode, toTopLevelFrame)
    showArrangementPreview(editor, Object.fromEntries(plan.patches.map(({ id, transform }) => [id, { transform }])))
  } catch (error) {
    if (!(error instanceof SelectionCommandError)) throw error
    editor.setLiveArrangement(null)
  }
}

export function tidySelection(editor: Editor) {
  editor.setLiveArrangement(null)
  if (!commitPendingEdits(editor)) return
  const patches = tidyPatches(editor)
  if (patches) editor.change('整理图层', draft => {
    for (const [id, patch] of Object.entries(patches)) draft.nodes[id].transform = patch.transform
  })
}
