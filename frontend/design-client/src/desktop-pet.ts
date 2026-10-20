import { desktopBridge } from './desktop'
import type { Editor } from './engine'

export type PetMode = 'off' | 'quiet' | 'active'
export type PetStatus = { mode: PetMode; phase: 'off' | 'starting' | 'ready' | 'unavailable'; revision: number }
export type PetEvent = 'edit' | 'save' | 'undo' | 'export' | 'error' | 'navigation-start' | 'navigation-end'
const key = 'core-desktop-pet-mode'
const ignoreFailure = (action: () => unknown) => { try { void Promise.resolve(action()).catch(() => {}) } catch { /* The optional companion must never interrupt editing. */ } }

/** Only semantic enum values cross IPC. Never forward document content or input events. */
export class DesktopPet {
  private mode: PetMode = 'off'
  private status: 'off' | 'checking' | 'ready' | 'unavailable' = 'off'
  private configuration = 0
  private revision = -1
  private listeners = new Set<() => void>()
  private last = new Map<PetEvent, number>()
  private navigation = false
  private held = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private bridge = desktopBridge) {}
  snapshot = () => this.mode
  statusSnapshot = () => this.status
  private acceptStatus(value: unknown): boolean {
    const status = value as Partial<PetStatus> | undefined
    if (!status || !['off', 'quiet', 'active'].includes(status.mode || '') ||
        !['off', 'starting', 'ready', 'unavailable'].includes(status.phase || '') ||
        !Number.isSafeInteger(status.revision) || status.revision! < 0) return false
    if (status.revision! < this.revision) return true
    this.revision = status.revision!
    this.status = status.phase === 'starting' ? 'checking' : status.phase!
    this.publish()
    return true
  }
  private publish() { for (const listener of this.listeners) listener() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  configure(mode: PetMode, persist = true): boolean {
    this.mode = mode
    this.stopNavigation()
    this.last.clear()
    let saved = true
    if (persist) { try { localStorage.setItem(key, mode) } catch { saved = false } }
    const generation = ++this.configuration, previousRevision = this.revision
    this.status = 'checking'
    const settle = (reply: unknown) => {
      if (generation !== this.configuration) return
      if (this.acceptStatus(reply)) return
      // A newer valid push wins over a late transport failure for this request.
      if (this.revision > previousRevision) return
      this.status = 'unavailable'
      this.publish()
    }
    try { void Promise.resolve(this.bridge()?.petConfigure?.(mode)).then(settle, () => settle(undefined)) }
    catch { settle(undefined) }
    this.publish()
    return saved
  }
  start() {
    let mode: PetMode = 'off'
    try { const saved = localStorage.getItem(key); if (saved === 'quiet' || saved === 'active') mode = saved } catch { /* Default off. */ }
    this.configure(mode, false)
  }
  event(event: Exclude<PetEvent, 'navigation-start' | 'navigation-end'>) {
    if (this.mode === 'off') return
    const now = Date.now(), previous = this.last.get(event)
    // Drop bursts before IPC; do not defer an old reaction into a later task.
    if (previous !== undefined && now - previous < 1200) return
    this.last.set(event, now)
    ignoreFailure(() => this.bridge()?.petEvent?.(event))
  }
  navigate(held = this.held) {
    if (this.mode === 'off') return
    this.held = held
    if (!this.navigation) {
      this.navigation = true
      ignoreFailure(() => this.bridge()?.petEvent?.('navigation-start'))
    }
    clearTimeout(this.timer)
    if (!held) this.timer = setTimeout(() => this.stopNavigation(), 250)
  }
  releaseNavigation() { if (this.navigation) this.navigate(false) }
  stopNavigation() {
    clearTimeout(this.timer); this.timer = undefined; this.held = false
    if (this.navigation) ignoreFailure(() => this.bridge()?.petEvent?.('navigation-end'))
    this.navigation = false
  }
  bind(editor: Pick<Editor, 'subscribeEdits'>) {
    let mounted = true
    let unsubscribe: (() => void) | undefined
    try { unsubscribe = this.bridge()?.onPetStatus?.(status => { if (mounted) this.acceptStatus(status) }) } catch { /* Optional transport. */ }
    this.start()
    const remove = editor.subscribeEdits(event => this.event(event.kind === 'undo' ? 'undo' : 'edit'))
    return () => { mounted = false; remove(); ignoreFailure(() => unsubscribe?.()); this.configure('off', false) }
  }
}
export const desktopPet = new DesktopPet()
