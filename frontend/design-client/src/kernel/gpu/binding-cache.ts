/** Device-local descriptors. Resource identity (including the uniform buffer
 * and offset) is part of every key; pixel/uniform contents are never cached.
 * The bounded group map cannot retain unlimited retired texture descriptors. */
export class GpuBindingCache {
  private ids = new WeakMap<object, number>()
  private next = 0
  private views = new WeakMap<GPUTexture, GPUTextureView>()
  private groups = new Map<string, GPUBindGroup>()
  viewCreates = 0
  groupCreates = 0
  groupHits = 0
  constructor(readonly limit = 2048) {}
  begin() { this.viewCreates = this.groupCreates = this.groupHits = 0 }
  clear() { this.groups.clear(); this.views = new WeakMap(); this.ids = new WeakMap(); this.next = 0 }
  get size() { return this.groups.size }
  view(texture: GPUTexture) {
    let view = this.views.get(texture)
    if (!view) { view = texture.createView(); this.views.set(texture, view); this.viewCreates++ }
    return view
  }
  group(resources: readonly object[], offset: number, create: () => GPUBindGroup) {
    const key = resources.map(resource => {
      let id = this.ids.get(resource)
      if (id === undefined) { id = ++this.next; this.ids.set(resource, id) }
      return id
    }).join('/') + ':' + offset
    const hit = this.groups.get(key)
    if (hit) {
      this.groups.delete(key); this.groups.set(key, hit); this.groupHits++; return hit
    }
    const group = create(); this.groupCreates++
    if (this.groups.size >= this.limit) this.groups.delete(this.groups.keys().next().value!)
    this.groups.set(key, group)
    return group
  }
}
