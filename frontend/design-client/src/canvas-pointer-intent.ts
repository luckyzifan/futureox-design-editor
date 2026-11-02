import type { DesignDocument, DesignNode, Point } from './model'
import { pointInContours, segmentDistance } from './geometry'
import { interactivePath } from './selection-hierarchy'

/** A title is canvas chrome outside the authored shape's hit bounds. It may
 * target only a visible, unlocked frame/section belonging to this page. */
export function frameTitleHit(document:DesignDocument,page:string,id:string|null|undefined):string|null {
  if(!id)return null
  const n=document.nodes[id]
  return n&&['frame','section'].includes(n.kind)&&interactivePath(document,page,id).length?id:null
}

export type SelectionPointerIntent = {
  /** Selection used while the pointer is held, including when a drag starts. */
  selection: string[]
  /** Apply only after a click release. Null means pointerdown already applied it. */
  clickSelection: string[] | null
}

/** A selected group's transparent interior still belongs to its drag frame.
 * Keep click-through deferred until release so a drag cannot move a backing
 * layer. Deep/additive selection and read-only feedback retain normal picking.
 */
export function selectedGroupDragIntent(
  group: Pick<DesignNode, 'id' | 'kind' | 'visible' | 'locked'> | null,
  hit: string | null,
  options: { inside: boolean; deep: boolean; additive: boolean; readOnly: boolean },
): SelectionPointerIntent | null {
  if (!group || group.kind !== 'group' || !group.visible || group.locked ||
      !options.inside || options.deep || options.additive || options.readOnly) return null
  return { selection: [group.id], clickSelection: hit === group.id ? null : hit ? [hit] : [] }
}

const THIN_SELECTION_PX = 8
const SELECTION_SLOP_PX = 6

function screenThickness(corners: readonly Point[], zoom: number): number {
  if (corners.length < 2 || !(zoom > 0)) return Infinity
  const edge = (index: number) => {
    const a = corners[index], b = corners[(index + 1) % corners.length]
    return Math.hypot(b.x - a.x, b.y - a.y) * zoom
  }
  return Math.min(edge(0), edge(1))
}

function screenDistanceToQuad(corners: readonly Point[], point: Point, zoom: number): number {
  let nearest = Infinity
  for (let index = 0; index < corners.length; index++)
    nearest = Math.min(nearest, segmentDistance(point, corners[index], corners[(index + 1) % corners.length]) * zoom)
  return nearest
}

/** An already selected layer keeps the drag. Overlapping text, and any hit
 * within the slop of a thin bar, is only applied if the pointer never moves.
 * Deep, additive and read-only presses keep the kernel hit. Groups use the
 * hollow-group rule instead. */
export function selectedOwnedDragIntent(
  node: Pick<DesignNode, 'id' | 'kind' | 'visible' | 'locked'> | null,
  hit: string | null,
  hitKind: string | null,
  corners: readonly Point[],
  point: Point,
  zoom: number,
  options: { deep: boolean; additive: boolean; readOnly: boolean },
): SelectionPointerIntent | null {
  if (!node || node.kind === 'group' || !node.visible || node.locked || options.deep || options.additive || options.readOnly) return null
  if (corners.length < 4 || !(zoom > 0)) return null
  const inside = pointInContours(point, [corners as Point[]])
  const thickness = screenThickness(corners, zoom)
  const thin = thickness < THIN_SELECTION_PX
  const slop = thin ? Math.max(SELECTION_SLOP_PX, (THIN_SELECTION_PX - thickness) / 2) : 0
  const near = thin && screenDistanceToQuad(corners, point, zoom) <= slop
  if (!inside && !near) return null
  if (hit === null || hit === node.id) return { selection: [node.id], clickSelection: null }
  if (hitKind === 'text' || thin) return { selection: [node.id], clickSelection: [hit] }
  return null
}

/** An already selected child keeps its drag target in transparent parts of
 * its outline. A painted ancestor is only a deferred click target there;
 * foreground siblings and explicit deep/additive picking retain normal rules. */
export function selectedChildDragIntent(
  child: Pick<DesignNode, 'id' | 'visible' | 'locked'> | null,
  hit: string | null,
  ancestors: readonly string[],
  options: { inside: boolean; deep: boolean; additive: boolean; readOnly: boolean },
): SelectionPointerIntent | null {
  if (!child || !child.visible || child.locked || !ancestors.length || !options.inside ||
      options.deep || options.additive || options.readOnly || hit !== null && !ancestors.includes(hit)) return null
  return { selection: [child.id], clickSelection: hit ? [hit] : [] }
}

/** Defer destructive selection changes until a click is distinguishable from a
 * drag. In particular, Shift can constrain an existing selection's movement. */
export function selectionPointerDown(
  current: readonly string[],
  hit: string | null,
  additive: boolean,
  insideSelectionGap = false,
): SelectionPointerIntent {
  if(hit===null && !additive && insideSelectionGap && current.length>1)
    return {selection:[...current],clickSelection:[]}
  if (hit === null) return { selection: additive ? [...current] : [], clickSelection: null }
  if (!current.includes(hit))
    return { selection: additive ? [...current, hit] : [hit], clickSelection: null }
  return {
    selection: [...current],
    clickSelection: additive ? current.filter(id => id !== hit) : current.length > 1 ? [hit] : null,
  }
}

/** Coordinates and threshold are CSS screen pixels, independent of zoom/DPR.
 * The default 3 px is Forma's product threshold, not a measured Figma value.
 * Once dragging starts, returning to the origin cannot turn it into a click. */
export function dragThresholdPassed(start: Point, now: Point, alreadyMoved: boolean, threshold = 3): boolean {
  if (alreadyMoved) return true
  if (!Number.isFinite(threshold) || threshold < 0 ||
    ![start.x, start.y, now.x, now.y].every(Number.isFinite)) return false
  const distance = Math.hypot(now.x - start.x, now.y - start.y)
  return distance > 0 && distance >= threshold
}
