import { BitmapRetirement } from './bitmap-retirement'
import { touchCompositeContributors } from './composite-cache-use'
import { estimatedTileResidencyBytes, TileResidencyLedger } from './page-memory-policy'
import { TILE_SIDE } from './tile-cache'

type Payload = Parameters<typeof estimatedTileResidencyBytes>[0] extends Iterable<infer T> ? T : never
export type AdmissionTile = Payload & { key: string; prefetch?: true }
export type TileAdmissionDiagnostic = Readonly<{ proposedBytes: number; budgetBytes: number; heldCount: number;
  usedCount: number; pinnedCount: number; incomingBytes: number; reserveBytes: number }>
export class TileAdmissionBudgetError extends Error {
  constructor(readonly diagnostic: TileAdmissionDiagnostic) { super('显示瓦片缓存预算超限') }
}
/** The surface settled this delivery's ownership: it either retained the
 * admitted payload or disposed the rejected one. Transport must still reject
 * the request, without disposing its payload a second time. */
export class HandledTileDeliveryError extends Error {
  constructor(readonly cause: unknown, readonly cleanupError?: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}
export function isTileAdmissionBudgetError(error: unknown): boolean {
  return error instanceof TileAdmissionBudgetError ||
    error instanceof HandledTileDeliveryError && isTileAdmissionBudgetError(error.cause)
}
export function tileAdmissionDiagnostic(error: unknown): TileAdmissionDiagnostic | undefined {
  return error instanceof TileAdmissionBudgetError ? error.diagnostic :
    error instanceof HandledTileDeliveryError ? tileAdmissionDiagnostic(error.cause) : undefined
}

/** One replacement frame may borrow existing inactive-page headroom. The cap
 * is recomputed, never added to prior reservations; history/prefetch cannot
 * borrow. Partial pan columns/rows and filtering gutters are included. */
export function replacementTileBudget(steady: number, total: number,
  viewport: { width: number; height: number; dpr: number; bytesPerPixel: number }, foreground: boolean) {
  const valid = [steady, total].every(value => Number.isSafeInteger(value) && value >= 0) && total >= steady &&
    [viewport.width, viewport.height, viewport.dpr, viewport.bytesPerPixel].every(value => Number.isFinite(value) && value > 0)
  const frameBytes = valid ? (Math.ceil(viewport.width * viewport.dpr / TILE_SIDE) + 1) *
    (Math.ceil(viewport.height * viewport.dpr / TILE_SIDE) + 1) * (TILE_SIDE + 2) ** 2 * viewport.bytesPerPixel : 0
  const reserveBytes = foreground && valid && Number.isSafeInteger(frameBytes)
    ? Math.max(0, Math.min(frameBytes, Math.floor(steady / 3), total - steady)) : 0
  return { reserveBytes, budgetBytes: steady + reserveBytes }
}

/** Plan the complete admission before touching live readiness or payloads.
 * In particular, discovering that all remaining pixels are protected must
 * leave earlier eviction candidates and same-key residents usable. */
export function planTileAdmission<T extends AdmissionTile>(live: ReadonlyMap<string, T>, incoming: T,
  options: { budget: number; reserveBytes?: number; used: ReadonlySet<T>; held: Iterable<T>; pinned: (key: string, tile: T) => boolean }) {
  const map = touchCompositeContributors(live, options.used), retired = new Set<T>()
  const replaced = map.get(incoming.key)
  if (replaced) retired.add(replaced)
  map.delete(incoming.key)
  if (incoming.prefetch) {
    const rest = [...map]
    map.clear(); map.set(incoming.key, incoming)
    for (const [key, value] of rest) map.set(key, value)
  } else map.set(incoming.key, incoming)
  const held = [...new Set(options.held)].filter(tile => map.get(tile.key) !== tile)
  const pinned = new Set([...map].filter(([key, tile]) => options.pinned(key, tile)).map(([key]) => key))
  const ledger = new TileResidencyLedger([...map.values(), ...held])
  for (const [key, tile] of map) {
    if (ledger.bytes <= options.budget) break
    if (pinned.has(key) || options.used.has(tile)) continue
    map.delete(key); retired.add(tile); ledger.remove(tile)
  }
  const bytes = ledger.bytes
  const diagnostic = Object.freeze({ proposedBytes: bytes, budgetBytes: options.budget, heldCount: held.length,
    usedCount: options.used.size, pinnedCount: pinned.size, incomingBytes: estimatedTileResidencyBytes([incoming]),
    reserveBytes: options.reserveBytes || 0 })
  if (!Number.isSafeInteger(options.budget) || options.budget < 0 || bytes > options.budget)
    throw new TileAdmissionBudgetError(diagnostic)
  return { map, retired, bytes, held, diagnostic }
}

/** Failed admission transfers no live ownership. Aliased bitmaps/handles may
 * still belong to an earlier successful delivery or the held display. */
export function retireRejectedTile<T extends AdmissionTile>(incoming: T, survivors: Iterable<T>,
  retirement: BitmapRetirement, release: (ids: number[]) => void) {
  const live = [...survivors]
  try { retirement.retire([incoming], live) }
  finally {
    if (incoming.gpuTile && !live.some(tile => tile.gpuTile === incoming.gpuTile)) release([incoming.gpuTile])
  }
}
