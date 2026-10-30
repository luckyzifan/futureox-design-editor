import { Immer, current, isDraft, enablePatches } from 'immer'
// Patch listeners are used only by the authored-document producer below.
enablePatches()
const drafting = new Immer({ autoFreeze: false })
export const produceDraft = drafting.produce
export const produceDraftWithPatches = drafting.produceWithPatches
export function cloneValue<T>(value: T): T {
  return structuredClone(isDraft(value) ? current(value as object) : value) as T
}
