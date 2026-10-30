import type { Editor } from './engine'
import { validColor } from './color'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'
import type { PropertyPreviewLease, PropertyPreviewResult, SolidFillTarget } from './property-preview'

export type ColorDraft = Readonly<{ color: string; opacity: string }>
/** Local UI draft. The Editor retains all target/transaction authority. */
export class ColorEditSession {
  readonly lease: PropertyPreviewLease
  readonly original: ColorDraft
  private value: ColorDraft
  private composing = false
  private closed = false
  private generation = 0
  private listeners = new Set<() => void>()
  private unregister: () => void
  private unsubscribe: () => void
  private controller: AbortController | null = null
  valid = true
  error = ''
  private constructor(readonly editor: Editor, lease: PropertyPreviewLease, initial: ColorDraft, private readonly originalOpacity: number) {
    this.lease = lease
    this.original = initial
    this.value = initial
    this.unregister = registerPendingEdit(editor, { dirty: () => this.active && (this.dirty || !this.valid || this.composing),
      commit: () => this.commit() })
    this.unsubscribe = editor.subscribe(() => {
      if (!this.closed && !editor.isPropertyPreviewCurrent(lease)) { editor.cancelProperty(lease); this.finish() }
    })
  }
  static open(editor: Editor, target: SolidFillTarget): ColorEditSession | null {
    const lease = editor.acquirePropertyPreview([target])
    if (!lease) return null
    const p = editor.authoredDocument.nodes[target.nodeId].fills[target.fillIndex]
    return new ColorEditSession(editor, lease, { color: p.color, opacity: String(p.opacity * 100) }, p.opacity)
  }
  get draft(): ColorDraft { return this.value }
  get active() { return !this.closed && this.editor.isPropertyPreviewCurrent(this.lease) }
  get dirty() { return this.value.color !== this.original.color || this.value.opacity !== this.original.opacity }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener(); pendingEditsChanged(this.editor) }
  setComposing(composing: boolean) {
    if (!this.active) return
    this.composing = composing
    if (composing) { this.editor.setPropertyPreviewValidity(this.lease, false); this.emit() }
    else this.update({})
  }
  update(patch: Partial<ColorDraft>): PropertyPreviewResult {
    if (!this.active) return 'stale'
    this.generation++
    this.controller?.abort(); this.controller = null
    this.value = { ...this.value, ...patch }
    const opacity = this.value.opacity.trim()
    this.valid = validColor(this.value.color, !!this.editor.authoredDocument.colorManagement) &&
      /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(opacity) && Number(opacity) >= 0 && Number(opacity) <= 100
    this.error = this.valid ? '' : '请输入有效颜色和 0–100 的填充不透明度'
    this.editor.setPropertyPreviewValidity(this.lease, this.valid && !this.composing)
    if (!this.valid || this.composing) { this.emit(); return 'blocked' }
    // Alpha-only changes preserve the original color bytes, including HDR.
    const result = this.editor.previewProperty(this.lease, { color: this.value.color, opacity: this.value.opacity === this.original.opacity ? this.originalOpacity : Number(opacity) / 100 })
    if (result === 'rejected') { this.valid = false; this.error = '当前颜色无法应用，输入已保留' }
    this.emit()
    return result
  }
  commit(): boolean {
    if (!this.active) return this.closed
    if (this.composing || !this.valid) { this.error = '请先完成有效颜色输入'; this.emit(); return false }
    const result = this.editor.commitProperty(this.lease)
    if (result === 'committed' || result === 'unchanged') { this.finish(); return true }
    this.error = '颜色提交失败，输入已保留'; this.emit(); return false
  }
  cancel() { if (this.active) this.editor.cancelProperty(this.lease); this.finish() }
  private finish() {
    if (this.closed) return
    this.closed = true
    this.generation++
    this.controller?.abort(); this.controller = null
    this.unsubscribe(); this.unregister()
    this.emit()
  }
  dispose() { this.cancel(); this.listeners.clear() }
  /** Every await retains both the lease and local draft generation. Typing,
   * cancellation, session reset or a newer request rejects an old sample. */
  async sample(read: (signal: AbortSignal, lease: PropertyPreviewLease) => Promise<{ sRGBHex: string }>) {
    if (!this.active || this.composing) return
    this.controller?.abort()
    const controller = new AbortController(), generation = ++this.generation
    this.controller = controller
    try {
      const result = await read(controller.signal, this.lease)
      if (controller.signal.aborted || !this.active || generation !== this.generation) return
      if (!/^#[\da-f]{6}$/i.test(result.sRGBHex)) throw new Error('invalid sample')
      this.update({ color: result.sRGBHex })
    } catch (error) {
      if (!controller.signal.aborted && this.active && generation === this.generation && (error as Error).name !== 'AbortError') {
        this.error = '画布取色失败，请重试'; this.emit()
      }
    } finally { if (this.controller === controller) this.controller = null }
  }
}
