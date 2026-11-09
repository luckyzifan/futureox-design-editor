/** Map aliases with an exact reverse index. Snapshot indices on set(), since
 * owners/collision buckets can be extended in place before being republished. */
export class ReverseIndexMap<K, V, I> extends Map<K, V> {
  private reverse = new Map<I, Set<K>>()
  private indexed = new Map<K, Set<I>>()
  private empty = new Set<K>()
  constructor(private indices: (value: V) => Iterable<I>) { super() }
  override set(key: K, value: V): this {
    this.unindex(key)
    super.set(key, value)
    const indices = new Set(this.indices(value))
    this.indexed.set(key, indices)
    for (const index of indices) {
      const keys = this.reverse.get(index) || new Set<K>()
      keys.add(key); this.reverse.set(index, keys)
    }
    return this
  }
  private unindex(key: K) {
    for (const index of this.indexed.get(key) || []) {
      const keys = this.reverse.get(index)
      keys?.delete(key)
      if (!keys?.size) this.reverse.delete(index)
    }
    this.indexed.delete(key)
  }
  override delete(key: K) { this.unindex(key); return super.delete(key) }
  override clear() { super.clear(); this.reverse.clear(); this.indexed.clear() }
  keysFor(index: I): ReadonlySet<K> { return this.reverse.get(index) || this.empty }
  protected appendIndex(key: K, index: I) {
    const indices = this.indexed.get(key)
    if (!indices || indices.has(index)) return
    indices.add(index)
    const keys = this.reverse.get(index) || new Set<K>()
    keys.add(key); this.reverse.set(index, keys)
  }
}

/** Mutable owner histories only grow between delete/clear boundaries. Adding
 * one owner must not rebuild the history of every earlier mask consumer. */
export class ReverseIndexSetMap<K, I> extends ReverseIndexMap<K, Set<I>, I> {
  constructor() { super(value => value) }
  add(key: K, index: I): this {
    let values = this.get(key)
    if (!values) { values = new Set<I>(); this.set(key, values) }
    if (!values.has(index)) {
      values.add(index)
      this.appendIndex(key, index)
    }
    return this
  }
}
