/** Content-free operation lifecycle. No document, node IDs, labels, or values leave this collector.
 * Exact presentation proves submission of the matching snapshot, NOT pixel correctness.
 * Detail is opt-in; counters and pending correlation remain bounded without it.
 */
export type OperationCategory = 'move' | 'resize' | 'text' | 'property' | 'undo' | 'redo' | 'other'
export type OperationOutcome = 'pending' | 'committed' | 'cancelled' | 'unchanged' | 'rejected' | 'session-ended'
export type OperationRecord = {
  operation: number; session: number; category: OperationCategory; targetCount: number
  startRevision: number; authoredRevision: number | null; outcome: OperationOutcome
  previewAttempts: number; previewAccepted: number
  presentation: 'unobserved' | 'exact-snapshot-acknowledged'; presentationEvidence: 'snapshot-identity-only'
}
const categories = new Set<OperationCategory>(['move', 'resize', 'text', 'property', 'undo', 'redo', 'other'])
const bounded = (n: number) => Number.isFinite(n) ? Math.min(1_000_000_000, Math.max(0, Math.trunc(n))) : 0
export function gestureCategory(label: string): OperationCategory {
  return label === '移动图层' ? 'move' : label === '缩放图层' || label === '等比缩放图层' ? 'resize' : 'other'
}
export function patchCategory(patch: object | Function): OperationCategory {
  if (typeof patch === 'function') return 'property'
  if (Object.hasOwn(patch, 'text') || Object.hasOwn(patch, 'textRuns')) return 'text'
  if (Object.hasOwn(patch, 'width') || Object.hasOwn(patch, 'height')) return 'resize'
  if (Object.hasOwn(patch, 'transform')) return 'move'
  return 'property'
}
export class CanvasOperationDiagnostics {
  private active = new Map<number, OperationRecord>()
  private serial = 0
  private records = new Map<number, OperationRecord>()
  private pending = new Map<number, { session: number; revision: number; document: number; page: number; record: OperationRecord }>()
  private identities = new WeakMap<object, number>()
  private identitySerial = 0
  private pages = new Map<string, number>()
  private detail = false
  private totals = { started: 0, committed: 0, cancelled: 0, rejected: 0, exactAcknowledged: 0, evictedUnobserved: 0 }
  constructor(private readonly capacity = 128, private readonly emit: (phase: 1 | 2 | 3 | 4, record: Readonly<OperationRecord>, document?: object) => void = () => {}, private readonly closeSink: () => void = () => {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 512) throw new Error('Invalid diagnostics capacity')
  }
  enableDetail(enabled: boolean) { this.detail = enabled; if (!enabled) this.records.clear() }
  private identity(document: object) {
    let id = this.identities.get(document)
    if (id === undefined) { id = ++this.identitySerial; this.identities.set(document, id) }
    return id
  }
  private page(page: string) {
    // Only pending page identifiers retained, bounded along with operations.
    let id = this.pages.get(page)
    if (id === undefined) { id = ++this.identitySerial; this.pages.set(page, id) }
    return id
  }
  begin(session: number, revision: number, category: OperationCategory, targetCount: number) {
    const operation = ++this.serial
    this.totals.started++
    const record: OperationRecord = { operation, session: bounded(session), category: categories.has(category) ? category : 'other', targetCount: bounded(targetCount), startRevision: bounded(revision), authoredRevision: null, outcome: 'pending', previewAttempts: 0, previewAccepted: 0, presentation: 'unobserved', presentationEvidence: 'snapshot-identity-only' }
    this.active.set(operation, record)
    while (this.active.size > this.capacity) this.active.delete(this.active.keys().next().value!)
    if (this.detail) {
      this.records.set(operation, record)
      while (this.records.size > this.capacity) this.records.delete(this.records.keys().next().value!)
    }
    this.output(1, record)
    return operation
  }
  preview(operation: number, accepted: boolean) {
    const record = this.active.get(operation)
    if (record?.outcome === 'pending') { record.previewAttempts = bounded(record.previewAttempts + 1); record.previewAccepted = bounded(record.previewAccepted + Number(accepted)) }
  }
  finish(operation: number, outcome: Exclude<OperationOutcome, 'pending'>, session: number, revision: number, document?: object, page?: string) {
    const record = this.active.get(operation)
    if (!record || !this.active.delete(operation)) return
    if (record && record.outcome !== 'pending') return
    if (record) { record.outcome = outcome; record.authoredRevision = outcome === 'committed' ? bounded(revision) : null }
    this.output(2, record, document)
    if (outcome === 'committed' || outcome === 'cancelled' || outcome === 'rejected') this.totals[outcome]++
    if (outcome === 'committed' && document && page !== undefined) {
      this.pending.set(operation, { session, revision, document: this.identity(document), page: this.page(page), record })
      while (this.pending.size > this.capacity) { this.pending.delete(this.pending.keys().next().value!); this.totals.evictedUnobserved++ }
      const used = new Set([...this.pending.values()].map(p => p.page))
      for (const [key, id] of this.pages) if (!used.has(id)) this.pages.delete(key)
    }
  }
  acknowledge(session: number, revision: number, document: object, page: string, preview: boolean) {
    if (preview) return
    const identity = this.identities.get(document), pageId = this.pages.get(page)
    for (const [operation, expected] of this.pending) {
      if (expected.session !== session || expected.revision !== revision || expected.document !== identity || expected.page !== pageId) continue
      const record = expected.record
      record.presentation = 'exact-snapshot-acknowledged'
      this.output(3, record)
      this.pending.delete(operation); this.totals.exactAcknowledged++
    }
  }
  endSession() {
    for (const record of this.active.values()) { record.outcome = 'session-ended'; this.output(4, record) }
    this.active.clear(); this.pending.clear(); this.pages.clear(); this.identities = new WeakMap()
  }
  private output(phase: 1 | 2 | 3 | 4, record: OperationRecord, document?: object) { try { this.emit(phase, { ...record }, document) } catch { /* Diagnostics must not reject edits. */ } }
  close() { this.endSession(); this.closeSink() }
  snapshot() { return { totals: { ...this.totals }, pendingCount: this.pending.size, records: [...this.records.values()].map(record => ({ ...record })) } }
}
