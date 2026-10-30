import { TileCache } from './tile-cache'

export const LOD_SNAPSHOT_BUDGET = 16 * 1024 * 1024

/** Owns immutable SDR snapshots for one raster revision. A mounted Tile may
 * borrow a canvas through its render/effect closure. Replacement, eviction,
 * revision changes and unmount release only the owner's reference: they never
 * close, resize or repaint a borrowed source. GC reclaims it after its final
 * borrower releases it. This avoids ImageBitmap.close racing React effects.
 *
 * The snapshot cache has a separate 16 MiB ceiling in addition to the existing
 * display-tile budget. Many exact tiles borrow the same coarse snapshot.
 * Retired snapshots can survive only while a mounted borrower still uses them.
 */
export class LodSnapshotCache {
  private revision: number | null = null
  private readonly snapshots: TileCache<HTMLCanvasElement>

  constructor(
    readonly maxBytes = LOD_SNAPSHOT_BUDGET,
    private readonly createCanvas = () => document.createElement('canvas'),
  ) {
    this.snapshots = new TileCache(maxBytes)
  }

  get bytes() { return this.snapshots.bytes }
  get size() { return this.snapshots.size }

  beginRevision(revision: number) {
    if (this.revision === revision) return
    this.clear()
    this.revision = revision
  }

  publish(revision: number, key: string, source: HTMLCanvasElement): boolean {
    if (revision !== this.revision) return false
    const bytes = source.width * source.height * 4
    if (!source.width || !source.height || bytes > this.maxBytes) return false
    // Copy synchronously before the producer reports ready or gets unmounted.
    // Its DOM canvas may later be reused; the published canvas never is.
    const snapshot = this.createCanvas()
    snapshot.width = source.width
    snapshot.height = source.height
    const context = snapshot.getContext('2d', { alpha: true, colorSpace: 'srgb' })
    if (!context) throw new Error('无法创建粗略预览快照')
    context.drawImage(source, 0, 0)
    this.snapshots.set(key, snapshot, bytes)
    return true
  }

  borrow(revision: number, key: string): HTMLCanvasElement | undefined {
    return revision === this.revision ? this.snapshots.get(key) : undefined
  }

  clear() {
    this.snapshots.clear()
    this.revision = null
  }
}
