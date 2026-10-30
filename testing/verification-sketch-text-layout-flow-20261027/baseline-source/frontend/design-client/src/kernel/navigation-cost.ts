import type { RasterTile, TileFillPriority } from './tile-cache'

/** Measured request work, not GPU completion or input-to-display latency.
 * Coverage tiers always win; aging prevents cheap refinements starving a
 * costly visible region. Entries belong to one content/device scope. */
export class NavigationCost {
  private scope = ''
  private costs = new Map<string, number>()
  private skipped = new Map<string, number>()
  reset(scope: string) { if (scope !== this.scope) { this.scope = scope; this.costs.clear(); this.skipped.clear() } }
  record(scope: string, key: string, milliseconds: number) {
    if (scope !== this.scope || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 120000) return
    const old = this.costs.get(key)
    this.costs.delete(key); this.costs.set(key, old === undefined ? milliseconds : old * .75 + milliseconds * .25)
    while (this.costs.size > 256) this.costs.delete(this.costs.keys().next().value!)
  }
  choose<T extends RasterTile>(ordered: readonly T[], priorities: ReadonlyMap<T, TileFillPriority>): T | undefined {
    if (!ordered.length) { this.skipped.clear(); return }
    const tier = Math.min(...ordered.map(tile => priorities.get(tile) ?? 2))
    const candidates = ordered.filter(tile => (priorities.get(tile) ?? 2) === tier)
    const average = this.costs.size ? [...this.costs.values()].reduce((a,b)=>a+b,0) / this.costs.size : 1
    const score = (tile: T) => tile.width * tile.height / Math.max(1, this.costs.get(tile.key) ?? average)
    const oldest = candidates.find(tile => (this.skipped.get(tile.key) || 0) >= 4)
    const selected = oldest || candidates.reduce((best,tile)=>score(tile)>score(best)?tile:best)
    const next = new Map<string,number>()
    for (const tile of candidates.slice(0,256)) if (tile !== selected) next.set(tile.key,(this.skipped.get(tile.key)||0)+1)
    this.skipped = next
    return selected
  }
}
