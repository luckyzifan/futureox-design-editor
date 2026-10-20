/** Inactive page pixels share the active display budget. This cache owns no
 * worker/device and no document/history copy. Exact immutable document identity
 * plus the session/raster scope are the validity witness, never a lossy hash.
 * Borrowers stay mounted until eviction, so an uploaded bitmap need not decode
 * again. The surface remains responsible for normal texture/bitmap retirement.
 */
export class PageResidencyCache<T> {
  private entries = new Map<string, { values: T[]; bytes: number }>()
  private document: object | undefined
  private scope = ''
  bytes = 0
  hits = 0
  constructor(readonly limit = 32 * 1024 * 1024, readonly maxPages = 3, private readonly retire: (value: T) => void = () => {}) {}
  synchronize(document: object, scope: string) {
    if (this.document === document && this.scope === scope) return false
    this.clear(); this.document = document; this.scope = scope
    return true
  }
  store(page: string, values: T[], bytes: number) {
    this.remove(page)
    if (!values.length || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) return
    this.entries.set(page, { values, bytes }); this.bytes += bytes
    this.trim(this.limit)
  }
  take(page: string, countHit = true): T[] | undefined {
    const entry = this.entries.get(page)
    if (!entry) return
    this.entries.delete(page); this.bytes -= entry.bytes
    if (countHit) this.hits++
    return entry.values
  }
  trim(available: number) {
    const before = this.entries.size
    while (this.entries.size && (this.bytes > Math.max(0, Math.min(this.limit, available)) || this.entries.size > this.maxPages))
      this.remove(this.entries.keys().next().value!)
    return before !== this.entries.size
  }
  values(): T[] { return [...this.entries.values()].flatMap(entry => entry.values) }
  private remove(page: string) { this.take(page, false)?.forEach(this.retire) }
  clear() { for (const page of this.entries.keys()) this.remove(page) }
  get size() { return this.entries.size }
}
