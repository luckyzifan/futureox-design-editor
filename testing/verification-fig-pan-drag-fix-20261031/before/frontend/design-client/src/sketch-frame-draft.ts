import { validSketchFrame } from '../../design-desktop/src/sketch-session-contract.mjs'
import type { SketchNativeFrame } from './desktop'
export type SketchFrameDraft = Record<keyof SketchNativeFrame, string>
/** Keep authored input strings until a confirmed revision supplies new native values. */
export function parseSketchFrameDraft(draft: SketchFrameDraft): SketchNativeFrame | null {
  if (Object.values(draft).some(value => typeof value !== 'string' || !value.trim())) return null
  const value = { x: Number(draft.x), y: Number(draft.y), width: Number(draft.width), height: Number(draft.height) }
  return validSketchFrame(value) ? value : null
}
