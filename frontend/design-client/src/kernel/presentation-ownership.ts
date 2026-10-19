/** Delivered GPU textures belong to the surface even before React mounts a
 * compositor child. Reconcile after presentation, so batched replacements and
 * evictions cannot orphan handles that the child never observed. */
export class PresentationOwnership {
  private ids = new Set<number>()
  track(id: number | undefined) { if (id) this.ids.add(id) }
  retireExcept(keep: Iterable<number | undefined>): number[] {
    const live = new Set(keep), retired: number[] = []
    for (const id of this.ids) if (!live.has(id)) { retired.push(id); this.ids.delete(id) }
    return retired
  }
  clear() { this.ids.clear() }
  get size() { return this.ids.size }
}
