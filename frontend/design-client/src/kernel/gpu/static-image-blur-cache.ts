import { exactBlendLattice } from './effect-region'
import { TILE_SIDE } from '../tile-cache'
import type { Rect, Texture } from './types'

export const STATIC_IMAGE_BLUR_CACHE_BYTES = 17 * 1024 * 1024
const MAX_ENTRIES = 1
/** A performance-only admission rule: retain the complete large tile, never
 * its narrow capture-edge pieces. It does not replace any source/halo proof. */
export function largeStaticImageBlurWindow(r: Rect, nativeOutput?: Rect): boolean {
  return !!nativeOutput && nativeOutput.w === TILE_SIDE + 2 && nativeOutput.h === TILE_SIDE + 2 &&
    exactBlendLattice([r, nativeOutput]) && r.w >= 1024 && r.h >= 1024 && r.w * r.h * 16 <= STATIC_IMAGE_BLUR_CACHE_BYTES
}
type Plane = { texture: Texture; rect: Rect }
declare const sourceBrand: unique symbol
export type StaticImageBlurSource = { readonly [sourceBrand]: true }
type Source = { texture: Texture; resource: unknown; width: number; height: number; proof: object; uri: string; policy: string }
type Entry = { source: StaticImageBlurSource; key: string; input: Rect; plane: Plane; epoch: number;
  lastUseEpoch: number; accepted: boolean; ready: boolean; retired: boolean; readers: number }
const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Exact same-window results only. The renderer registers sources after an
 * actual managed upload and stages only a native-axis-certified full-support
 * blur. Neither packet declarations nor public finite flags mint identities.
 * All planes stay in the renderer's ordinary 256 MiB ledger. */
export class StaticImageBlurCache {
  private sources = new WeakMap<Texture, StaticImageBlurSource>()
  private proofs = new WeakMap<StaticImageBlurSource, Source>()
  private entries: Entry[] = []
  private context?: string
  private completedEpoch = 0
  constructor(private release: (plane: Plane) => void,
    private currentProof: (texture: Texture) => object | undefined) {}
  registerUpload(texture: Texture, proof: object, uri: string, policy: string): StaticImageBlurSource | undefined {
    if (!uri || !policy || this.currentProof(texture) !== proof) return
    this.retireSource(texture)
    const source = Object.freeze({}) as StaticImageBlurSource
    this.sources.set(texture, source); this.proofs.set(source, { texture, resource: texture.resource,
      width: texture.width, height: texture.height, proof, uri, policy })
    return source
  }
  source(texture: Texture, uri: string, policy: string): StaticImageBlurSource | undefined {
    const token = this.sources.get(texture), source = token && this.proofs.get(token)
    // URI already is an immutable complete string. Equality binds every byte,
    // including ICC/EXIF, without serializing it into another large string.
    if (!source || source.uri !== uri || source.policy !== policy) return
    if (!this.valid(token!)) { this.retireSource(texture); return }
    return token
  }
  private valid(source: StaticImageBlurSource) {
    const proof = this.proofs.get(source)
    return !!proof && this.sources.get(proof.texture) === source && proof.texture.resource === proof.resource &&
      proof.texture.width === proof.width && proof.texture.height === proof.height && this.currentProof(proof.texture) === proof.proof
  }
  get bytes() { return this.entries.reduce((sum, entry) => sum + entry.plane.texture.bytes, 0) }
  get count() { return this.entries.filter(entry => !entry.retired).length }
  get pinnedSourceBytes() {
    return [...new Set(this.entries.map(entry => this.proofs.get(entry.source)?.texture).filter((t): t is Texture => !!t))]
      .reduce((sum, texture) => sum + texture.bytes, 0)
  }
  has(texture: Texture) { return this.entries.some(entry => entry.plane.texture === texture) }
  pinsSource(texture: Texture) { return this.entries.some(entry => this.proofs.get(entry.source)?.texture === texture) }
  private retire(entry: Entry) {
    entry.retired = true
    if (entry.readers || entry.lastUseEpoch > this.completedEpoch) return
    this.entries = this.entries.filter(candidate => candidate !== entry)
    this.release(entry.plane)
  }
  retireSource(texture: Texture) {
    this.sources.delete(texture)
    for (const entry of [...this.entries]) if (this.proofs.get(entry.source)?.texture === texture) this.retire(entry)
  }
  begin(context: string | undefined, completedEpoch?: number) {
    if (this.context !== context) { this.clear(); this.context = context }
    for (const entry of [...this.entries]) if (!entry.accepted) this.retire(entry)
    this.promote(completedEpoch)
  }
  collect(completedEpoch?: number) { this.promote(completedEpoch) }
  private promote(completedEpoch?: number) {
    if (Number.isSafeInteger(completedEpoch)) this.completedEpoch = Math.max(this.completedEpoch, completedEpoch!)
    for (const entry of [...this.entries]) {
      if (entry.retired) { this.retire(entry); continue }
      if (!this.valid(entry.source)) { this.retire(entry); continue }
      if (entry.accepted && this.completedEpoch >= entry.epoch) entry.ready = true
    }
  }
  borrow(source: StaticImageBlurSource, key: string, input: Rect, output: Rect, completedEpoch?: number, readEpoch?: number) {
    this.promote(completedEpoch)
    if (!Number.isSafeInteger(readEpoch) || readEpoch! <= 0) return
    const entry = this.entries.find(entry => !entry.retired && entry.ready && entry.source === source &&
      entry.key === key && same(entry.input, input) && same(entry.plane.rect, output))
    if (!entry) return
    entry.readers++
    entry.lastUseEpoch = Math.max(entry.lastUseEpoch, readEpoch!)
    this.entries = [...this.entries.filter(candidate => candidate !== entry), entry]
    let released = false
    return { plane: entry.plane, release: () => {
      if (released) return
      released = true; entry.readers--
      if (entry.retired) this.retire(entry)
    } }
  }
  stage(source: StaticImageBlurSource, key: string, input: Rect, plane: Plane, epoch?: number): boolean {
    const r = plane.rect, texture = plane.texture
    if (!this.context || !this.valid(source) || !key || !exactBlendLattice([input, r]) ||
      input.w <= 0 || input.h <= 0 || r.w <= 0 || r.h <= 0 || r.x < input.x || r.y < input.y ||
      r.x + r.w > input.x + input.w || r.y + r.h > input.y + input.h ||
      texture.width !== r.w || texture.height !== r.h || texture.bytes !== r.w * r.h * 16 ||
      texture.bytes > STATIC_IMAGE_BLUR_CACHE_BYTES || this.has(texture) ||
      !Number.isSafeInteger(epoch) || epoch! <= 0) return false
    for (const entry of [...this.entries]) if (entry.source === source && entry.key === key &&
      same(entry.input, input) && same(entry.plane.rect, r)) this.retire(entry)
    while (this.bytes + texture.bytes > STATIC_IMAGE_BLUR_CACHE_BYTES || this.entries.length >= MAX_ENTRIES) {
      const old = this.entries.find(entry => !entry.readers && entry.lastUseEpoch <= this.completedEpoch)
      if (!old) return false
      this.retire(old)
    }
    this.entries.push({ source, key, input: { ...input }, plane: { texture, rect: { ...r } }, epoch: epoch!,
      lastUseEpoch: epoch!, accepted: false, ready: false, retired: false, readers: 0 })
    return true
  }
  finish(success: boolean, completedEpoch?: number) {
    for (const entry of [...this.entries]) if (!entry.accepted) {
      if (success) entry.accepted = true
      else this.retire(entry)
    }
    this.promote(completedEpoch)
  }
  /** Pressure may retire optional results, but cannot pool a currently borrowed
   * plane/source before its last queued read. No allocation occurs here. */
  clear() { for (const entry of [...this.entries]) this.retire(entry) }
  /** Unpublished results from this still-encoding frame may return to the
   * ordered render-target pool under pressure. Their producer/merge marked
   * them used; the renderer must fence before destroying that current pool.
   * Completed/previous-frame entries and borrowed reads never use this seam. */
  discardPending(epoch?: number) {
    if (!Number.isSafeInteger(epoch) || epoch! <= 0) return
    for (const entry of [...this.entries]) if (!entry.accepted && !entry.readers && entry.epoch === epoch) {
      entry.lastUseEpoch = 0
      this.retire(entry)
    }
  }
  /** Renderer/device teardown owns all remaining commands and resources. */
  dispose() {
    const entries = this.entries; this.entries = []
    for (const entry of entries) this.release(entry.plane)
  }
}
