import type { CanvasCamera } from '../canvas-camera'
import type { CompositeItem } from './gpu/tile-compositor'
import { compositeDrawPlan, compositeRasterQuad } from './gpu/composite-draw-plan'

export type CompositeCacheTile = CompositeItem['tile'] & {
  document?: object; revision: number; residentDevice?: Readonly<{ client: object; key: string }>
}
export type CompositeCacheOwner = {
  document: object; revision: number; pageId: string; epoch: number; backend: string
  client: object | null; resident: boolean; deviceKey?: string; visible: boolean
  view: CanvasCamera; width: number; height: number; dpr: number
}
export type CompositeCacheFrame<T extends CompositeCacheTile> = CompositeCacheOwner & {
  items: readonly (Omit<CompositeItem, 'tile'> & { tile: T })[]
}

/** Cache use is actual visible fragment ownership, not intersection alone.
 * Never infer a replacement from a new delivery that has not become ready on
 * this live device. A stale frame cannot confer use on a newer camera/owner.
 */
export function visibleCompositeContributors<T extends CompositeCacheTile>(
  frame: CompositeCacheFrame<T> | null, current: CompositeCacheOwner | null,
  live: ReadonlyMap<string, T>, ready: ReadonlySet<string>,
): Set<T> {
  const used = new Set<T>()
  if (!frame || !current || !current.client || !current.visible ||
      (['document', 'revision', 'pageId', 'epoch', 'backend', 'client', 'resident', 'deviceKey', 'visible', 'width', 'height', 'dpr'] as const)
        .some(key => !Object.is(frame[key], current[key])) ||
      (['x', 'y', 'zoom'] as const).some(key => !Object.is(frame.view[key], current.view[key])) ||
      ![frame.width, frame.height, frame.dpr].every(value => Number.isFinite(value) && value > 0)) return used
  const items = frame.items.filter(item => {
    const tile = item.tile
    return item.active && live.get(tile.key) === tile && ready.has(tile.key) &&
      tile.document === current.document && tile.revision === current.revision &&
      (!current.resident || Number.isSafeInteger(tile.gpuTile) && tile.gpuTile! > 0 && !!current.deviceKey &&
        tile.residentDevice?.client === current.client && tile.residentDevice.key === current.deviceKey)
  })
  for (const row of compositeDrawPlan(items, frame.view, frame.width, frame.height))
    if (compositeRasterQuad(row.placement, row.clip, frame.width, frame.height, frame.dpr)) used.add(row.item.tile as T)
  return used
}

/** Touch only still-owned contributors, preserving their relative Map order.
 * This also preserves stable equal-layer/equal-density painter ordering. */
export function touchCompositeContributors<T extends { key: string }>(live: ReadonlyMap<string, T>, used: ReadonlySet<T>): Map<string, T> {
  const next = new Map(live)
  for (const [key, tile] of live) if (used.has(tile)) { next.delete(key); next.set(key, tile) }
  return next
}
