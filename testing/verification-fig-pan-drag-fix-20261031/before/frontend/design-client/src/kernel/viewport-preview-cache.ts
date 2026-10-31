import { coordinateSlot } from './exact-tile-cache'
import type { CanvasCamera } from '../canvas-camera'

export type ViewportPreviewDevice = {
  client: object; deviceWorkerScope: number; deviceIncarnation: number; deviceOwner: number
}
export type ViewportPreviewIdentity = Readonly<{
  lane: 'navigation-preview' | 'sequential-viewport'
  client: object; document: object; revision: number; pageId: string; sessionEpoch: number
  dpr: number; backend: string; profile: string; precision: string; capability: unknown
  width: number; height: number; view: Readonly<CanvasCamera>
}>
export type ViewportPreviewCacheEntry = Readonly<{
  identity: ViewportPreviewIdentity
  /** Additional invalidation fence, stamped only when an actual submitted
   * frame acknowledges this already-owned GPU handle. Numeric diagnostics
   * alone never establish texture ownership or GPU completion. */
  device?: string
}>

/** Capture identity, not a screen-space coverage/scale approximation. Keep all
 * original binary64 camera coordinates, including phase and negative zero. */
export function viewportPreviewKey(identity: ViewportPreviewIdentity) {
  return `${identity.lane}:${JSON.stringify([identity.revision, identity.pageId, identity.sessionEpoch,
    identity.backend, identity.profile, identity.precision])}:${coordinateSlot([
    identity.view.x, identity.view.y, identity.view.zoom, identity.width, identity.height, identity.dpr,
  ])}`
}

export function captureViewportPreview(identity: ViewportPreviewIdentity): ViewportPreviewCacheEntry {
  // The device is deliberately unknown until the real presenter acknowledges
  // this handle. An old device's last metadata cannot certify a new capture.
  return Object.freeze({ identity: Object.freeze({ ...identity, view: Object.freeze({ ...identity.view }) }) })
}

export function viewportPreviewDeviceKey(owner: ViewportPreviewDevice | undefined) {
  if (!owner || ![owner.deviceWorkerScope, owner.deviceIncarnation, owner.deviceOwner]
    .every(value => Number.isSafeInteger(value) && value > 0)) return
  return `${owner.deviceWorkerScope}/${owner.deviceIncarnation}/${owner.deviceOwner}`
}

/** Reuse requires the original live payload, ready/import acknowledgement,
 * identical authored/raster owner and an actual presentation acknowledgement.
 * Time is intentionally absent: only eviction/invalidation ends residency. */
export function reusableViewportPreview(tile: {
  key: string; viewportPreview?: boolean; gpuTile?: number; viewportCache?: ViewportPreviewCacheEntry
}, identity: ViewportPreviewIdentity, ready: boolean, device: string | undefined) {
  const entry = tile.viewportCache, previous = entry?.identity
  return ready && tile.viewportPreview === true && Number.isSafeInteger(tile.gpuTile) && tile.gpuTile! > 0 &&
    !!device && entry?.device === device && !!previous && previous.client === identity.client &&
    previous.document === identity.document && previous.capability === identity.capability &&
    tile.key === viewportPreviewKey(identity) && viewportPreviewKey(previous) === tile.key
}
