import { exactBlendLattice } from './effect-region'
import { intersect, type PathMesh, type Rect, type Texture } from './types'

export const HORIZONTAL_FILTER_CACHE_BYTES = 64 * 1024 * 1024
type Plane = { texture: Texture; rect: Rect }
type Entry = { lease: object; key: string; image: Texture; plane: Plane }

/** The interval program is authoritative. Only accept four-sample rows whose
 * sole span has exact integer endpoints covering the requested pixels.
 * In particular, a nearly axis-aligned polygon need not have opaqueRect.
 * General endpoint arithmetic and non-sample programs keep the ordinary path. */
export function fullSampleCoverage(path: PathMesh, curves: number[] | Float32Array | undefined, region: Rect): boolean {
  if (!curves || !path.area || !path.count || path.sampleCount !== 4 ||
      !exactBlendLattice([path.rect, region]) || region.w <= 0 || region.h <= 0 ||
      region.w > 8192 || region.h > 8192 || region.x < path.rect.x || region.y < path.rect.y ||
      region.x + region.w > path.rect.x + path.rect.w || region.y + region.h > path.rect.y + path.rect.h) return false
  const { first, count } = path.area, start = first * 4, end = start + count * 4
  if (![first, count].every(Number.isSafeInteger) || first < 0 || count < 1 || end > curves.length ||
      curves[start] !== 3 || curves[start + 1] !== 1 ||
      curves[start + 2] !== path.rect.w || curves[start + 3] !== path.rect.h) return false
  const left = region.x - path.rect.x, right = left + region.w
  for (let row = region.y - path.rect.y; row < region.y - path.rect.y + region.h; row++) {
    for (let sample = 0; sample < 4; sample++) {
      const record = start + 4 + (row * 4 + sample) * 4
      if (record + 4 > end || curves[record + 1] !== 1) return false
      const span = curves[record], at = start + span * 4
      if (!Number.isSafeInteger(span) || span < 1 + path.rect.h * 4 || at + 12 > end ||
          !Number.isSafeInteger(curves[at]) || !Number.isSafeInteger(curves[at + 1]) ||
          curves[at] > left || curves[at + 1] < right) return false
      // range.zw and the two encoded f64 remainders must all be exact zero.
      for (let component = 2; component < 12; component++) if (curves[at + component] !== 0) return false
    }
  }
  return true
}

/** Type-tag every value and encode numbers as their original binary64 words.
 * Neither -0 nor a string/object resembling an encoded number can collide. */
export function exactFilterKey(values: unknown[]): string | undefined {
  let finite = true
  const storage = new ArrayBuffer(8), view = new DataView(storage)
  const encode = (value: unknown): unknown => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) finite = false
      view.setFloat64(0, value, false)
      return ['number', view.getUint32(0, false), view.getUint32(4, false)]
    }
    if (value === null) return ['null']
    if (Array.isArray(value)) return ['array', value.map(encode)]
    if (typeof value === 'object') return ['object', Object.keys(value).sort()
      .map(key => [key, encode((value as Record<string, unknown>)[key])])]
    return [typeof value, value]
  }
  const key = JSON.stringify(encode(values))
  return finite ? key : undefined
}

/** One immutable completed plane, within the renderer's existing total ledger.
 * A newly encoded plane is not visible until finish succeeds. The release
 * callback returns storage to the renderer's ordered pool; never destroys it. */
export class HorizontalFilterCache {
  private entry?: Entry
  private pending?: Entry
  constructor(private release: (plane: Plane) => void) {}
  begin(lease: object | undefined) {
    if (this.pending || this.entry?.lease !== lease) this.clear()
  }
  has(texture: Texture) { return this.entry?.plane.texture === texture || this.pending?.plane.texture === texture }
  get bytes() { return (this.entry?.plane.texture.bytes || 0) + (this.pending?.plane.texture.bytes || 0) }
  get(lease: object, key: string, image: Texture, requested: Rect) {
    const entry = this.entry
    if (!entry || entry.lease !== lease || entry.key !== key || entry.image !== image ||
        entry.plane.rect.x !== requested.x || entry.plane.rect.w !== requested.w ||
        !exactBlendLattice([entry.plane.rect, requested])) return
    const overlap = intersect(entry.plane.rect, requested)
    if (!overlap.w || !overlap.h) return
    return { plane: entry.plane, overlap }
  }
  stage(lease: object, key: string, image: Texture, plane: Plane): boolean {
    if (!Number.isSafeInteger(plane.texture.bytes) || plane.texture.bytes <= 0 ||
        plane.texture.bytes > HORIZONTAL_FILTER_CACHE_BYTES) return false
    this.clear()
    this.pending = { lease, key, image, plane }
    return true
  }
  finish(success: boolean) {
    if (!success) { this.clear(); return }
    if (this.pending) { this.entry = this.pending; this.pending = undefined }
  }
  clear(lease?: object) {
    for (const name of ['entry', 'pending'] as const) {
      const entry = this[name]
      if (entry && (!lease || entry.lease === lease)) {
        this[name] = undefined
        this.release(entry.plane)
      }
    }
  }
}
