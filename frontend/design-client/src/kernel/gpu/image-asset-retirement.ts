type Retirement = { covered: boolean }

/** Image storage survives until the queue boundary that covers its last
 * reads. A captured cohort cannot release a later retirement of that image. */
export class ImageAssetRetirement<T extends { bytes: number }> {
  private readonly entries = new Map<T, Retirement>()

  get size() { return this.entries.size }
  get bytes() {
    let bytes = 0
    for (const texture of this.entries.keys()) bytes += texture.bytes
    return bytes
  }

  keys() { return this.entries.keys() }
  clear() { this.entries.clear() }

  retire(texture: T) {
    this.entries.set(texture, { covered: false })
  }

  capture(unpinned: (texture: T) => boolean): ReadonlyMap<T, Retirement> {
    const cohort = new Map<T, Retirement>()
    for (const [texture, entry] of this.entries) {
      if (!entry.covered && unpinned(texture)) cohort.set(texture, entry)
    }
    return cohort
  }

  cover(cohort: ReadonlyMap<T, Retirement>, unpinned: (texture: T) => boolean) {
    for (const [texture, entry] of cohort) {
      if (this.entries.get(texture) === entry && unpinned(texture)) entry.covered = true
    }
  }

  collect(unpinned: (texture: T) => boolean, release: (texture: T) => void) {
    for (const [texture, entry] of this.entries) {
      if (!entry.covered || !unpinned(texture)) continue
      this.entries.delete(texture)
      release(texture)
    }
  }
}
