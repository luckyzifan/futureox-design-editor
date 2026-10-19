import { validSketchTextOverride } from '../../design-desktop/src/sketch-session-contract.mjs'
import type { SketchTextOverride } from './desktop'
export type SketchTextOverrideDraft = { targetPath: string; text: string; clearText: boolean }
/** Do not trim native IDs or authored text; empty replacement needs an explicit choice. */
export function parseSketchTextOverrideDraft(instanceId: string, draft: SketchTextOverrideDraft): SketchTextOverride | null {
  if (draft.text === '' && !draft.clearText) return null
  const value = { instanceId, targetPath: draft.targetPath, text: draft.text }
  return validSketchTextOverride(value) ? value : null
}
