import type { Editor } from './engine'
import { frameSizePresetGate } from './frame-presets'
import { interfacePreference } from './interface-preference'
import { commitPendingEdits } from './pending-edits'

/** Shell session for the Sketch frame-template search. It is not document state. */
type Listener = () => void
const listeners = new Set<Listener>()
let generation = 0
let frameId: string | null = null

function emit() {
  for (const listener of [...listeners]) listener()
}

export function subscribeFrameTemplate(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Zero while closed. A new positive generation opens a fresh search. */
export function frameTemplateSnapshot() {
  return generation
}

export function frameTemplateFrameId() {
  return frameId
}

export function requestFrameTemplate(frame: string) {
  if (generation > 0 && frameId === frame) return
  frameId = frame
  generation += 1
  emit()
}

export function closeFrameTemplate() {
  if (!generation) return
  generation = 0
  frameId = null
  emit()
}

/** Sketch layout, one editable frame, and no gesture in progress. */
export function frameTemplateReplaceAvailable(editor: Editor) {
  if (interfacePreference.getSnapshot().uiMode !== 'sketch') return false
  if (editor.state.busy || editor.interactionActive) return false
  return frameSizePresetGate(editor.state.doc, editor.state.page, editor.state.selection, editor.parentMap()) === 'ready'
}

/** Open the existing apply search. Pending input is committed only after the
 * frame is already eligible, matching the inspector entry. A refused open
 * does not change the document. */
export function openFrameTemplateReplace(editor: Editor) {
  if (!frameTemplateReplaceAvailable(editor)) return false
  const id = editor.state.selection[0]
  if (!id || !commitPendingEdits(editor)) return false
  if (!frameTemplateReplaceAvailable(editor) || editor.state.selection[0] !== id) return false
  requestFrameTemplate(id)
  return true
}
