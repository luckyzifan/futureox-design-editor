import { CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX, type CanvasCamera } from './canvas-camera'

export const CAMERA_STATE_KEY = 'forma-camera-state-v1'
const LIMIT = 64
const MAX_BYTES = 65536
type Entry = { documentId: string; pageId: string; view: CanvasCamera }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

/** Optional navigation hints, never authored document data. Keep doubles intact;
 * positions outside artwork are intentional and must not trigger auto-fit. */
export function savedCamera(value: unknown): CanvasCamera | undefined {
  if (!value || typeof value !== 'object') return
  const { x, y, zoom } = value as CanvasCamera
  if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return
  return { x, y, zoom: Math.max(CANVAS_ZOOM_MIN, Math.min(CANVAS_ZOOM_MAX, zoom)) }
}

export class CameraState {
  private entries: Entry[] | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private sessionPages = new Set<string>()
  constructor(
    private storage: () => Storage | undefined = () => typeof window === 'undefined' ? undefined : window.localStorage,
    private persist: () => boolean = () => true,
  ) {}
  private read() {
    if (this.entries) return this.entries
    this.entries = []
    try {
      const raw = this.storage()?.getItem(CAMERA_STATE_KEY)
      if (!raw || raw.length > MAX_BYTES) return this.entries
      const data = JSON.parse(raw)
      if (data.version !== 1 || !Array.isArray(data.entries)) return this.entries
      for (const item of data.entries.slice(-LIMIT)) {
        const view = savedCamera(item?.view)
        if (view && typeof item.documentId === 'string' && item.documentId.length <= 256 &&
          typeof item.pageId === 'string' && item.pageId.length <= 256)
          this.entries.push({ documentId: item.documentId, pageId: item.pageId, view })
      }
    } catch { /* Denied or damaged storage must never block editing. */ }
    return this.entries
  }
  recall(documentId: string, pageIds: readonly string[], pageId?: string, includePersisted = true): Entry | undefined {
    const entry = [...this.read()].reverse().find(item => item.documentId === documentId &&
      pageIds.includes(item.pageId) && (pageId === undefined || item.pageId === pageId) &&
      (includePersisted || this.sessionPages.has(JSON.stringify([item.documentId, item.pageId]))))
    return entry && { ...entry, view: { ...entry.view } }
  }
  remember(documentId: string, pageId: string, value: CanvasCamera) {
    const view = savedCamera(value)
    if (!view || documentId.length > 256 || pageId.length > 256) return
    this.sessionPages.add(JSON.stringify([documentId, pageId]))
    const entries = this.read()
    const last = entries.at(-1)
    if (last?.documentId === documentId && last.pageId === pageId &&
      last.view.x === view.x && last.view.y === view.y && last.view.zoom === view.zoom) return
    this.entries = entries.filter(item => item.documentId !== documentId || item.pageId !== pageId)
    this.entries.push({ documentId, pageId, view })
    if (this.entries.length > LIMIT) this.entries.shift()
    this.dirty = true
    // No serialization or synchronous storage in the wheel/render hot path.
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    // Session-only navigation has no asynchronous work to flush. In particular,
    // document replacement must not leave an unrelated persistence timer alive.
    if (this.persist()) this.timer = setTimeout(() => this.flush(), 400)
  }
  flush() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    try {
      if (this.persist()) {
        const encoded = JSON.stringify({ version: 1, entries: this.read() })
        if (encoded.length <= MAX_BYTES) this.storage()?.setItem(CAMERA_STATE_KEY, encoded)
      }
    } catch { /* Memory recall remains available when persistence is denied. */ }
    this.dirty = false
  }
}
