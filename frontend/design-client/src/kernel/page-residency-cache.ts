/** Authored revision/resource/font/color identity is the immutable document
 * object passed to synchronize. Camera, viewport, density and phase remain in
 * each RasterTile's exact key/geometry; they are not collapsed to this scope. */
export type PageResidencyScope = Readonly<{
  documentId: string; sessionEpoch: number; backend: string; grid: boolean;
  checkerboard: boolean; pixelPreview: number; rasterProfile: string;
  displayCapability: unknown; hdrCompositing: boolean
}>
export function pageResidencyScope(scope: PageResidencyScope): string {
  return JSON.stringify([scope.documentId, scope.sessionEpoch, scope.backend, scope.grid,
    scope.checkerboard, scope.pixelPreview, scope.rasterProfile, scope.displayCapability, scope.hdrCompositing])
}

/** Inactive completed pixels only. Activation transfers ownership to the
 * surface, so active/in-flight resources are never LRU candidates. Immutable
 * document identity covers nodes, resources, fonts and color configuration;
 * scope covers session/device and raster options. Tile coordinates carry the
 * exact camera/density witness. A hit is reuse, not certification of a new frame.
 * The surface/compositor owns GPU retirement, not this cache. */
export class PageResidencyCache<T> {
  private entries = new Map<string, { values: T[]; bytes: number }>()
  private document: object | undefined
  private scope = ''
  hits = 0
  misses = 0
  evictions = 0
  constructor(public limit = 32 * 1024 * 1024, public maxPages = 3,
    private readonly retire: (value: T) => void = () => {},
    private readonly measure?: (values: Iterable<T>) => number) { this.validate(limit, maxPages) }
  private validate(limit: number, maxPages: number) {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxPages) || maxPages < 0)
      throw new Error('Invalid page residency budget')
  }
  configure(limit: number, maxPages: number) {
    this.validate(limit, maxPages); this.limit = limit; this.maxPages = maxPages
    return this.trim(limit)
  }
  synchronize(document: object, scope: string) {
    if (this.document === document && this.scope === scope) return false
    this.clear(); this.document = document; this.scope = scope
    return true
  }
  store(page: string, values: T[], bytes: number) {
    const unique = [...new Set(values)], preserve = new Set(unique)
    // Moving an object between pages moves its ownership, rather than leaving
    // two inactive owners able to dispose each other's live resource.
    for (const [key, entry] of this.entries)
      if (key === page || entry.values.some(value => preserve.has(value))) this.remove(key, preserve)
    if (!unique.length || !Number.isSafeInteger(bytes) || bytes < 0 ||
        (this.measure ? this.measure(unique) : bytes) > this.limit || !this.maxPages) return false
    this.entries.set(page, { values: unique, bytes }); this.trim(this.limit)
    return this.entries.has(page)
  }
  take(page: string, countHit = true): T[] | undefined {
    const entry = this.entries.get(page)
    if (!entry) { if (countHit) this.misses++; return }
    this.entries.delete(page)
    if (countHit) this.hits++
    return entry.values
  }
  // The optional pressure predicate measures the current union with externally
  // pinned resources after every eviction. Shared inactive bytes can fall
  // without reducing that union, so a precomputed allowance is insufficient.
  trim(available: number, overBudget?: (values: readonly T[]) => boolean) {
    const before = this.entries.size
    // Invalid pressure signals fail closed, never silently disable eviction.
    const budget = Number.isFinite(available) ? Math.max(0, Math.min(this.limit, available)) : 0
    while (this.entries.size && (this.bytes > budget || this.entries.size > this.maxPages || overBudget?.(this.values()))) {
      this.remove(this.entries.keys().next().value!); this.evictions++
    }
    return before !== this.entries.size
  }
  values(): T[] { return [...new Set([...this.entries.values()].flatMap(entry => entry.values))] }
  private remove(page: string, preserve = new Set<T>()) {
    for (const value of this.take(page, false) || []) if (!preserve.has(value)) this.retire(value)
  }
  clear() { for (const page of this.entries.keys()) this.remove(page) }
  get bytes() { return this.measure ? this.measure(this.values()) : [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
  get size() { return this.entries.size }
}
