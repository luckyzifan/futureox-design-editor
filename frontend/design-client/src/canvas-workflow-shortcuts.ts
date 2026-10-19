import type { Editor } from './engine'
import type { DesignDocument } from './model'
import { allParents } from './geometry'
import { propertyUnits } from './property-units'
import { interactivePath, marqueeScope } from './selection-hierarchy'
import { resizeNodeDimension, selectionMetric } from './selection-properties'
import type { ShortcutProfile } from './shortcut-profiles'

const dimensionNudges = {
  'resize-width-increase': { axis: 'width', delta: 1 },
  'resize-width-decrease': { axis: 'width', delta: -1 },
  'resize-height-increase': { axis: 'height', delta: 1 },
  'resize-height-decrease': { axis: 'height', delta: -1 },
  'resize-width-increase-large': { axis: 'width', delta: 10 },
  'resize-width-decrease-large': { axis: 'width', delta: -10 },
  'resize-height-increase-large': { axis: 'height', delta: 10 },
  'resize-height-decrease-large': { axis: 'height', delta: -10 },
} as const
export type DimensionNudgeCommand = keyof typeof dimensionNudges
export const dimensionNudgeCommands = Object.keys(dimensionNudges) as DimensionNudgeCommand[]
export function isDimensionNudgeCommand(command: string): command is DimensionNudgeCommand {
  return Object.hasOwn(dimensionNudges, command)
}

/** Keyboard dimensions share the Inspector/canvas resize contract. Compute all
 * values against one immutable snapshot before publishing a single history step.
 * This is per-layer sizing, not Scale-tool stretching or a multi-box transform. */
export function nudgeSelectionDimensions(editor: Editor, command: DimensionNudgeCommand): void {
  if (editor.state.busy || editor.interactionActive || !['select', 'scale'].includes(editor.state.tool)) return
  const { axis, delta } = dimensionNudges[command]
  const document = editor.state.doc, parents = allParents(document)
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
  editor.update([...edits.keys()], node => {
    const { value, units } = edits.get(node.id)!
    resizeNodeDimension(node, axis, value, document, units)
  }, '键盘调整图层尺寸')
}

/** Figma-like deliberately preserves the current page-level Select All policy.
 * Sketch-like selects direct siblings in the already-entered common container.
 * Neither includes hidden/locked paths or claims the forced-selection variants. */
export function selectAllCanvasIds(document: DesignDocument, page: string, selection: readonly string[], profile: ShortcutProfile): string[] {
  const parents = allParents(document)
  const scope = profile === 'sketch-like' ? marqueeScope(document, page, selection) : page
  const children = scope === page ? document.pages.find(value => value.id === page)?.children : document.nodes[scope]?.children
  return (children || []).filter(id => interactivePath(document, page, id, false, parents).length > 0)
}
