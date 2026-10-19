import { Immer, current, isDraft } from 'immer'
const drafting = new Immer({ autoFreeze: false })
export const produceDraft = drafting.produce
export function cloneValue<T>(value: T): T {
  return structuredClone(isDraft(value) ? current(value as object) : value) as T
}
