import type { CompositeItem } from './gpu/tile-compositor'

/** Live captures replace their clipped part of the settled page. Page quality
 * bands can change independently; none may cover an accepted interaction pose.
 * Preserve ordering between live intervals and retain the page outside them. */
export function liveInteractionStack(page: readonly CompositeItem[], live: readonly CompositeItem[]): CompositeItem[] {
  let pageTop = 0, liveBottom = Infinity
  for (const item of page) if (item.active) pageTop = Math.max(pageTop, item.layer)
  for (const item of live) if (item.active) liveBottom = Math.min(liveBottom, item.layer)
  if (!Number.isFinite(liveBottom)) return [...page, ...live]
  const offset = pageTop + 1 - liveBottom
  return [...page, ...live.map(item => ({ ...item, layer: item.layer + offset }))]
}
