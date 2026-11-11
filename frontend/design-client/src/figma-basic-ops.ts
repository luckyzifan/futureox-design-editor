/** Mac desktop Figma and Sketch share this entry. Double-click still moves one
 * container level. Text edits. An already selected outline enters point
 * editing without converting the shape; the first anchor edit does that. */
export type DoubleClickFollowUp = 'edit-text' | 'edit-vector' | 'instance' | 'select'

/** Parametric outlines that already have a detached editable network. Frames,
 * sections, groups, text, and slices keep their own Enter and double-click. */
const OUTLINE_EDIT_KINDS = new Set(['rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector'])

export function canEnterOutlineEdit(node: {
  kind: string
  locked?: boolean
  instance?: unknown
  instanceOrigin?: unknown
} | null | undefined): boolean {
  return !!node && node.locked !== true && node.instance == null && node.instanceOrigin == null && OUTLINE_EDIT_KINDS.has(node.kind)
}

/** Single unlocked top-level outline. Callers still give containers and text
 * priority, so Enter keeps selecting children and editing text. */
export function enterKeyEditsOutline(
  selection: readonly string[],
  topSelection: readonly string[],
  node: { id: string; kind: string; locked?: boolean; instance?: unknown; instanceOrigin?: unknown } | null | undefined,
): boolean {
  return selection.length === 1 && !!node && selection[0] === node.id && topSelection.includes(node.id) && canEnterOutlineEdit(node)
}

export function doubleClickFollowUp(
  result: { id: string; changed: boolean } | null,
  node: { id: string; kind: string; locked?: boolean; instance?: unknown; instanceOrigin?: unknown; network?: unknown } | null,
  topLevel: boolean,
): DoubleClickFollowUp {
  if (!result || !node || node.id !== result.id || !topLevel) return 'select'
  if (node.kind === 'text') return 'edit-text'
  if (!result.changed && node.instance) return 'instance'
  if (!result.changed && canEnterOutlineEdit(node)) return 'edit-vector'
  return 'select'
}

/** Enter selects children when the container has any. On a text layer it
 * starts editing. Outline entry is a separate decision and does not convert. */
export function enterKeyEditsText(node: { kind: string } | null, blockedByParent: boolean): boolean {
  return !!node && !blockedByParent && node.kind === 'text'
}

/** Mac desktop Figma deep-selects with Command. Control-click is the context
 * menu. Other platforms deep-select with Control. */
export function deepSelectChord(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform: 'mac' | 'windows' | 'linux',
): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey
}
