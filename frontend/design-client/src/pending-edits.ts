/** Input drafts belong to the editor, even before they become document changes.
 * Boundaries must commit every draft or leave the recoverable input in place. */
export type PendingEdit = { dirty: () => boolean; commit: () => boolean }
type Owner = object
const registries = new WeakMap<Owner, { edits: Set<PendingEdit>; listeners: Set<() => void> }>()
function registry(owner: Owner) {
  let value = registries.get(owner)
  if (!value) { value = { edits: new Set(), listeners: new Set() }; registries.set(owner, value) }
  return value
}
export function pendingEditsChanged(owner: Owner) {
  for (const listener of registry(owner).listeners) listener()
}
export function registerPendingEdit(owner: Owner, edit: PendingEdit) {
  registry(owner).edits.add(edit)
  return () => { registry(owner).edits.delete(edit); pendingEditsChanged(owner) }
}
export function subscribePendingEdits(owner: Owner, listener: () => void) {
  registry(owner).listeners.add(listener)
  return () => { registry(owner).listeners.delete(listener) }
}
export function hasPendingEdits(owner: Owner) {
  return [...registry(owner).edits].some((edit) => edit.dirty())
}
export function commitPendingEdits(owner: Owner & { notify: (message: string) => void }) {
  for (const edit of [...registry(owner).edits]) {
    if (edit.dirty() && !edit.commit()) {
      owner.notify('文字输入尚未完成或存在冲突；当前输入已保留，请完成输入后重试')
      return false
    }
  }
  return true
}

const operationEpochs = new WeakMap<Owner, number>()
export function pendingOperationEpoch(owner: Owner) { return operationEpochs.get(owner) || 0 }
export function cancelPendingOperations(owner: Owner) { operationEpochs.set(owner, pendingOperationEpoch(owner) + 1) }
