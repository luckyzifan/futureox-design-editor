import { paintDamageIntersects, type PaintDamage, type PaintRect } from './paint-damage'
import type { GpuScene } from './gpu/types'

type Entry = { bytes: Uint8Array; size: number; regional: boolean; scope?: { bounds: PaintRect; nodes: Set<string> } }
/** Exact compiler-input keys and privately owned packets. A retained packet is
 * admitted only by the kernel's translation proof AND disjoint paint/read bounds;
 * commands involving a changed node still compile again. Interaction captures,
 * export/animation and unknown policies never receive this exemption. */
export class CompiledPacketCache {
  private entries = new Map<string, Entry>()
  bytes = 0
  hits = 0
  retained = 0
  invalidated = 0
  constructor(private limit = 32 * 1024 * 1024, private maxPacket = 4 * 1024 * 1024) {}
  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key); this.entries.set(key, entry); this.hits++
    return entry.bytes.slice()
  }
  put(key: string, value: Uint8Array, regional = false) {
    if (value.byteLength > this.maxPacket) return
    const size = value.byteLength + key.length * 2 + 128
    if (size > this.limit) return
    const old = this.entries.get(key)
    if (old) { this.bytes -= old.size; this.entries.delete(key) }
    while (this.bytes + size > this.limit || this.entries.size >= 128) {
      const first = this.entries.keys().next().value!
      this.bytes -= this.entries.get(first)!.size
      this.entries.delete(first)
    }
    this.entries.set(key, { bytes: value.slice(), size, regional }); this.bytes += size
  }
  /** Consume the worker's existing decode; do not parse large metadata twice. */
  certify(key: string, scene: GpuScene) {
    const entry=this.entries.get(key),{extent:r,view:v}=scene
    if(!entry?.regional||entry.scope||scene.version!==8||scene.resolve||scene.presentation||!(v.zoom>0)||
      ![r.x,r.y,r.w,r.h,v.x,v.y,v.zoom].every(Number.isFinite))return
    const ids=Object.keys(scene.nodes),extra=ids.reduce((n,id)=>n+id.length*2+48,64)
    if(this.bytes+extra>this.limit)return
    entry.scope={bounds:[(r.x-v.x-2)/v.zoom,(r.y-v.y-2)/v.zoom,(r.w+4)/v.zoom,(r.h+4)/v.zoom],nodes:new Set(ids)}
    entry.size+=extra;this.bytes+=extra
  }
  applyDamage(damage: PaintDamage, changed: readonly string[]) {
    for (const [key, entry] of this.entries) {
      const keep = damage.translationOnly === true && !damage.full && entry.scope &&
        !changed.some(id=>entry.scope!.nodes.has(id)) && !paintDamageIntersects(damage,entry.scope.bounds)
      if (keep) { this.retained++; continue }
      this.entries.delete(key); this.bytes -= entry.size; this.invalidated++
    }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}
