import { ExactTileCache } from './exact-tile-cache'
import type {CompilationWitness,WitnessLookup} from './compilation-witness'

/** Owner partitions share one payload budget and one global LRU. A lane switch
 * is not invalidation. Configuration/device changes still invalidate all owners.
 * Values must be owned CPU bytes, never transferred bitmaps or driver textures. */
export class OwnerTileCache<T> {
  static readonly ownerMetadataBytes = 1024
  private readonly cache: ExactTileCache<T>
  private readonly generations = new Map<string, number>()
  private epoch = 0
  constructor(limit?: number, diagnostic?: (reasonCode: number, bytes: number) => void) {
    this.cache = new ExactTileCache<T>(limit, diagnostic)
    this.cache.reserve(Math.min(this.cache.limit, OwnerTileCache.ownerMetadataBytes))
  }
  owner(owner: string) {
    if (owner !== 'canvas' && owner !== 'interaction') throw new Error('Invalid tile cache owner')
    const prefix = JSON.stringify(owner) + '/'
    const key = (slot: string) => prefix + slot
    const belongs = (slot: string) => slot.startsWith(prefix)
    const generation = () => this.generations.get(owner) ?? 0
    const current = (ticket: { owner: string; epoch: number; generation: number }) =>
      ticket.owner === owner && ticket.epoch === this.epoch && ticket.generation === generation()
    return {
      get: (slot: string, witness: WitnessLookup) => this.cache.get(key(slot), witness),
      certified: (slot: string) => this.cache.certified(key(slot)),
      capture: () => ({ owner, epoch: this.epoch, generation: generation() }),
      current,
      set: (slot: string, witness: CompilationWitness, value: T, bytes: number,
        ticket?: { owner: string; epoch: number; generation: number }) => {
        if (ticket && !current(ticket)) return false
        this.cache.set(key(slot), witness, value, bytes)
        return true
      },
      revoke: (predicate: (value: T) => boolean) => {
        this.generations.set(owner, generation() + 1)
        this.cache.revoke((value, slot) => belongs(slot) && predicate(value))
      },
      clear: () => {
        this.cache.deleteWhere(belongs)
        this.generations.set(owner, generation() + 1)
      },
    }
  }
  clear() {
    this.cache.reserve(Math.min(this.cache.limit, OwnerTileCache.ownerMetadataBytes))
    this.epoch++; this.generations.clear()
  }
  get bytes() { return this.cache.bytes }
  get evictions() { return this.cache.evictions }
  get size() { return this.cache.size }
}

/** Cache entries survive transfer and device retirement only if their payload is
 * independent of the presentation owner. Do not clone or retain texture leases. */
export function ownsExactTileBytes(value: { buffer: ArrayBufferLike; bitmap?: unknown; gpuTile?: number }) {
  return value.buffer.byteLength > 0 && value.bitmap === undefined && value.gpuTile === undefined
}
