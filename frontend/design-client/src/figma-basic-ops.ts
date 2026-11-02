/** Follow-ups after selectDeeper. Figma double-click moves one container
 * level. Landing on text edits it. A second double-click on an already
 * selected vector enters point editing. Rectangles stay shapes. */
export type DoubleClickFollowUp = 'edit-text' | 'edit-vector' | 'instance' | 'select'

export function doubleClickFollowUp(
  result: { id: string; changed: boolean } | null,
  node: { id: string; kind: string; instance?: unknown; network?: unknown } | null,
  topLevel: boolean,
): DoubleClickFollowUp {
  if (!result || !node || node.id !== result.id || !topLevel) return 'select'
  if (node.kind === 'text') return 'edit-text'
  if (!result.changed && node.instance) return 'instance'
  if (!result.changed && (node.network || node.kind === 'vector')) return 'edit-vector'
  return 'select'
}

/** Enter selects children when the container has any. On a text layer it
 * starts editing. It does not turn rectangles into vectors. */
export function enterKeyEditsText(node: { kind: string } | null, blockedByParent: boolean): boolean {
  return !!node && !blockedByParent && node.kind === 'text'
}
