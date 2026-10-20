/** Payload retirement is distinct from GPU presentation retirement. Shared
 * ImageBitmaps close only after the last known live tile owner is gone. */
export class BitmapRetirement {
  private closed = new WeakSet<ImageBitmap>()
  retire<T extends { bitmap?: ImageBitmap }>(victims: Iterable<T>, survivors: Iterable<T>) {
    const live = new Set(survivors), protectedBitmaps = new Set([...live].flatMap(tile => tile.bitmap ? [tile.bitmap] : []))
    for (const tile of victims) {
      if (live.has(tile)) continue
      const bitmap = tile.bitmap
      tile.bitmap = undefined
      if (bitmap && !protectedBitmaps.has(bitmap) && !this.closed.has(bitmap)) {
        this.closed.add(bitmap); bitmap.close()
      }
    }
  }
}
