import type { Editor } from './engine'
import { commitPendingEdits } from './pending-edits'
import { planBatchRename } from './batch-rename'

export type BatchRenameSession = Readonly<{
  id: number; document: Editor['state']['doc']; pageId: string; selection: readonly string[]
  version: number; generation: number; stale: boolean
}>
type Store = { session: BatchRenameSession | null; listeners: Set<() => void>; stop?: () => void }
const stores = new WeakMap<Editor, Store>()
let sequence = 0
function store(editor: Editor) {
  let value = stores.get(editor)
  if (!value) { value = { session: null, listeners: new Set() }; stores.set(editor, value) }
  return value
}
function publish(value: Store) { value.listeners.forEach(listener => listener()) }
export function subscribeBatchRename(editor: Editor, listener: () => void) {
  const value = store(editor); value.listeners.add(listener)
  return () => { value.listeners.delete(listener) }
}
export function batchRenameSnapshot(editor: Editor) { return store(editor).session }
export function batchRenameIsCurrent(editor: Editor, session: BatchRenameSession) {
  return store(editor).session === session && !session.stale && editor.state.doc === session.document && editor.state.page === session.pageId && editor.state.version === session.version &&
    editor.sessionGeneration === session.generation && !editor.state.busy && !editor.interactionActive &&
    editor.state.selection.length === session.selection.length && editor.state.selection.every((id, index) => id === session.selection[index])
}
export function closeBatchRename(editor: Editor) {
  const value = store(editor)
  value.stop?.(); value.stop = undefined
  if (value.session) { value.session = null; publish(value) }
}
export function requestBatchRename(editor: Editor) {
  if (editor.state.busy || editor.interactionActive || !commitPendingEdits(editor)) return
  const { doc: document, page: pageId, version, selection } = editor.state
  planBatchRename(document, pageId, selection, {})
  closeBatchRename(editor)
  const value = store(editor)
  value.session = Object.freeze({ id: ++sequence, document, pageId, version, selection: Object.freeze([...selection]), generation: editor.sessionGeneration, stale: false })
  value.stop = editor.subscribe(() => {
    if (value.session && !value.session.stale && !batchRenameIsCurrent(editor, value.session)) {
      value.session = Object.freeze({ ...value.session, stale: true }); publish(value)
    }
  })
  publish(value)
}
