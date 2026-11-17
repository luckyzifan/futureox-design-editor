import { keyboardNudgeActive } from './keyboard-nudge-gesture'
import { nudgePreference } from './nudge-preference'
import type { Editor } from './engine'
import type { DesignDocument } from './model'
import { allParents } from './geometry'
import { propertyUnits } from './property-units'
import { interactivePath, marqueeScope } from './selection-hierarchy'
import { editableFrameCrop, frameCropPatches, resizeNodeDimension, selectionMetric } from './selection-properties'
import type { ShortcutProfile } from './shortcut-profiles'

const dimensionNudges = {
  'resize-width-increase': { axis: 'width', direction: 1, large: false },
  'resize-width-decrease': { axis: 'width', direction: -1, large: false },
  'resize-height-increase': { axis: 'height', direction: 1, large: false },
  'resize-height-decrease': { axis: 'height', direction: -1, large: false },
  'resize-width-increase-large': { axis: 'width', direction: 1, large: true },
  'resize-width-decrease-large': { axis: 'width', direction: -1, large: true },
  'resize-height-increase-large': { axis: 'height', direction: 1, large: true },
  'resize-height-decrease-large': { axis: 'height', direction: -1, large: true },
} as const
export type DimensionNudgeCommand = keyof typeof dimensionNudges
export const dimensionNudgeCommands = Object.keys(dimensionNudges) as DimensionNudgeCommand[]
export function isDimensionNudgeCommand(command: string): command is DimensionNudgeCommand {
  return Object.hasOwn(dimensionNudges, command)
}

/** Keyboard dimensions share the Inspector/canvas resize contract. Compute all
 * values against one immutable snapshot before publishing a single history step.
 * This is per-layer sizing, not Scale-tool stretching or a multi-box transform. */
export function nudgeSelectionDimensions(editor: Editor, command: DimensionNudgeCommand, ownedGesture = false, preserveFrameContents = false): void {
  if (editor.state.busy || (editor.interactionActive && !(ownedGesture && keyboardNudgeActive(editor))) || !['select', 'scale'].includes(editor.state.tool)) return
  const crop = preserveFrameContents || editor.state.frameCrop ? editableFrameCrop(editor) : undefined
  if (preserveFrameContents && !crop) return
  const { axis, direction, large } = dimensionNudges[command]
  const preference = nudgePreference.getSnapshot()
  const delta = direction * (large ? preference.big : preference.small)
  const document = editor.state.doc, parents = editor.parentMap()
  const edits = new Map(editor.topSelection().flatMap(id => {
    if (!interactivePath(document, editor.state.page, id, false, parents).length) return []
    const node = document.nodes[id], units = propertyUnits(document, id, parents)
    const current = selectionMetric(node, axis, document, units)
    // Match the existing dimension fields' representable range. Degenerate
    // axes cannot be recovered by multiplying a zero geometry extent.
    if (!Number.isFinite(current) || current <= 0) return []
    const value = Math.max(.01, Math.min(1e6, current + delta))
    return value === current ? [] : [[id, { value, units }] as const]
  }))
  if (!edits.size) return
  editor.update([...edits.keys()], (node, draft) => {
    const { value, units } = edits.get(node.id)!
    resizeNodeDimension(node, axis, value, document, units)
    if (node.id === crop) {
      const { transform, width, height } = node
      const patches = frameCropPatches(document, node.id, { transform, width, height })
      for (const id of node.children) if (patches[id]) Object.assign(draft.nodes[id], patches[id])
    }
  }, '键盘调整图层尺寸')
}

/** The sibling list the plain select-all operates on: the entered container,
 * or the current page when the selection does not share one container. */
function containerChildren(document: DesignDocument, page: string, selection: readonly string[], parents: ReturnType<typeof allParents>): readonly string[] {
  const scope = marqueeScope(document, page, selection, parents)
  return scope === page ? document.pages.find(value => value.id === page)?.children ?? [] : document.nodes[scope]?.children ?? []
}

/** Mac Figma and Sketch both select siblings inside the entered container.
 * An empty selection, a top-level selection, or a selection that does not
 * share one container falls back to the current page. Hidden and locked
 * paths stay out. */
export function selectAllCanvasIds(document: DesignDocument, page: string, selection: readonly string[], profile: ShortcutProfile): string[] {
  if (profile !== 'figma-like' && profile !== 'sketch-like') return []
  const parents = allParents(document)
  return containerChildren(document, page, selection, parents).filter(id => interactivePath(document, page, id, false, parents).length > 0)
}

/** Sketch ⌃⌘A: the same container scope as plain select-all, but hidden and
 * locked siblings join the selection (Sketch "Select All Including Hidden
 * and Locked Layers"). Sketch preset only; the plain preset keeps ⌘A. */
export function selectAllForceCanvasIds(document: DesignDocument, page: string, selection: readonly string[], profile: ShortcutProfile): string[] {
  if (profile !== 'sketch-like') return []
  return [...containerChildren(document, page, selection, allParents(document))]
}

/** Sketch ⇧⌘A: only the top-level frames and graphics of the current page,
 * leaving any entered container (Sketch "Select All Top-Level Frames and
 * Graphics"). Hidden and locked stay excluded, matching plain select-all. */
export function selectTopLevelCanvasIds(document: DesignDocument, page: string, profile: ShortcutProfile): string[] {
  if (profile !== 'sketch-like') return []
  const parents = allParents(document)
  return (document.pages.find(value => value.id === page)?.children ?? []).filter(id => interactivePath(document, page, id, false, parents).length > 0)
}
