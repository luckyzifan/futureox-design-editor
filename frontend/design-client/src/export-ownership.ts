import { desktopPet } from './desktop-pet'
import type { DesignDocument } from './model'
import { commitPendingEdits } from './pending-edits.ts'

type ExportEditor = {
  readonly sessionGeneration: number
  readonly state: { doc: DesignDocument; page: string; selection: string[]; version: number }
  subscribe(listener: () => void): () => void
}
type Identity = { session: number; doc: DesignDocument; id: string; page: string; selection: string; version: number }
export type ExportAsset = { url: string; name: string }
export type ExportRequest = {
  readonly document: DesignDocument
  readonly page: string
  readonly selection: readonly string[]
  readonly signal: AbortSignal
  isCurrent(): boolean
}
type ActiveRequest = ExportRequest & { key: string; controller: AbortController; ownsGeneration(): boolean }

function identity(editor: ExportEditor): Identity {
  return { session: editor.sessionGeneration, doc: editor.state.doc, id: editor.state.doc.id,
    page: editor.state.page, selection: JSON.stringify(editor.state.selection), version: editor.state.version }
}
function same(a: Identity, b: Identity): boolean {
  return a.session === b.session && a.doc === b.doc && a.id === b.id && a.page === b.page
    && a.selection === b.selection && a.version === b.version
}

/** Draft commits may advance document revision. Navigation during that commit,
 * including a page/selection ABA, must not silently change the export target. */
export function commitExportEdits(editor: ExportEditor & { notify(message: string): void }): boolean {
  const before = identity(editor)
  let navigated = false
  const check = () => {
    const now = identity(editor)
    if (now.session !== before.session || now.id !== before.id || now.page !== before.page || now.selection !== before.selection) navigated = true
  }
  const unsubscribe = editor.subscribe(check)
  try {
    if (!commitPendingEdits(editor)) return false
    check()
    if (navigated) {
      editor.notify('导出已取消：提交输入时编辑会话或目标已切换，请重新导出')
      return false
    }
    return true
  } finally { unsubscribe() }
}

/** One shared menu/Color export owner. Editor notifications retire intervening
 * identity changes even when page/selection later return to the same values. */
export class ExportOwner {
  private urls: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  constructor(urls: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void } = URL) { this.urls = urls }
  private active = false
  private generation = 0
  private current: ActiveRequest | null = null
  private preview: { asset: ExportAsset; ownsGeneration(): boolean } | null = null
  private observed: Identity | null = null
  private unsubscribe: (() => void) | null = null
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = (): ExportAsset | null => this.preview?.ownsGeneration() ? this.preview.asset : null
  private emit() { for (const listener of this.listeners) listener() }
  private observe(editor: ExportEditor) {
    const next = identity(editor)
    if (this.observed && !same(this.observed, next)) this.close()
    this.observed = next
  }
  activate(editor: ExportEditor) {
    this.unsubscribe?.()
    this.active = true
    this.observe(editor)
    this.unsubscribe = editor.subscribe(() => this.observe(editor))
  }
  dispose() {
    this.active = false
    this.unsubscribe?.(); this.unsubscribe = null
    this.close()
  }
  private releasePreview() {
    const previous = this.preview
    this.preview = null
    if (previous) this.urls.revokeObjectURL(previous.asset.url)
  }
  close() {
    this.generation++
    this.current?.controller.abort()
    this.current = null
    this.releasePreview()
    this.emit()
  }
  cancel(request: ExportRequest) {
    if (this.current === request) this.close()
  }
  begin(editor: ExportEditor, key: string): ExportRequest | null {
    this.observe(editor)
    if (!this.active) return null
    if (this.current?.key === key && this.current.isCurrent()) return null
    // Snapshot before asynchronous import/render. A failed copy adopts nothing.
    const document = structuredClone(editor.state.doc)
    const captured = identity(editor)
    this.close()
    const generation = this.generation
    const controller = new AbortController()
    const ownsGeneration = () => this.active && generation === this.generation && same(captured, identity(editor))
    const request: ActiveRequest = {
      key, controller, document, page: captured.page, selection: [...editor.state.selection], signal: controller.signal,
      ownsGeneration, isCurrent: () => this.current === request && !controller.signal.aborted && ownsGeneration(),
    }
    this.current = request
    return request
  }
  publish(request: ExportRequest, result: { blob: Blob; name: string }): boolean {
    if (this.current !== request || !request.isCurrent()) return false
    const current = this.current
    const url = this.urls.createObjectURL(result.blob)
    // Object URL creation is synchronous; retain the fence for reentrant hosts.
    if (!request.isCurrent()) { this.urls.revokeObjectURL(url); return false }
    this.releasePreview()
    desktopPet.event('export')
    this.preview = { asset: { url, name: result.name }, ownsGeneration: current.ownsGeneration }
    this.current = null
    this.emit()
    return true
  }
  finish(request: ExportRequest) {
    if (this.current === request) this.current = null
  }
}
