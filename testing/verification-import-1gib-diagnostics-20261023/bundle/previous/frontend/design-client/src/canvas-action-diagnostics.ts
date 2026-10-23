import { createCpuStageDiagnostics } from './cpu-stage-diagnostics'
import { operationCorrelation } from './canvas-operation-terminal'
import { createRenderDiagnostics, PREFIX } from '../../design-desktop/src/render-terminal-diagnostics.mjs'
/** Only enums/counts/booleans leave this module. Never text, IDs, keys, geometry, clipboard or errors. */
export const CanvasAction = { unknown: 0, pointer: 1, hitTest: 2, selection: 3, grab: 4, move: 10, resize: 11, scale: 12, rotate: 13, pivot: 14, marquee: 15, pan: 16, zoom: 17, create: 18, vertex: 19, handle: 20, width: 21, parameter: 22, crop: 23, text: 24, utility: 25, copy: 40, cut: 41, paste: 42, undo: 43, redo: 44, delete: 45, duplicate: 46, group: 47, ungroup: 48, selectAll: 49, command: 50, newDocument: 51, tool: 52, page: 53, save: 54, import: 55, export: 56, settings: 57, layer: 58, eraser: 60, boardCreate: 61, measure: 62, lasso: 63, bend: 64, guide: 65, layoutHandle: 66, smartSelection: 67, scrollbar: 68, offsetPath: 69, paintBucket: 70, textPath: 71, review: 72, propertyInput: 73 } as const
export const ActionSource = { unknown: 0, pointer: 1, keyboard: 2, menu: 3, properties: 4, automation: 5, clipboard: 6, lifecycle: 7 } as const
export const ActionOutcome = { pending: 0, observed: 1, committed: 2, unchanged: 3, cancelled: 4, blocked: 5, rejected: 6, unsupported: 7 } as const
export const ActionReason = { none: 0, belowThreshold: 1, locked: 2, busy: 3, notReady: 4, wrongOwner: 5, staleSession: 6, chrome: 7, editingText: 8, noTarget: 9, validation: 10, escape: 11, pointerCancel: 12, lostCapture: 13, sessionEnd: 14, unobserved: 15, unsupported: 16, superseded: 17 } as const
export type ActionCode = typeof CanvasAction[keyof typeof CanvasAction]
export type ActionSourceCode = typeof ActionSource[keyof typeof ActionSource]
export type ActionOutcomeCode = typeof ActionOutcome[keyof typeof ActionOutcome]
export type ActionEventOutcomeCode = Exclude<ActionOutcomeCode, typeof ActionOutcome.committed>
export type ActionReasonCode = typeof ActionReason[keyof typeof ActionReason]
/** Comparison fields:0 unobserved,1 equal,2 different,3 unsupported. Different is not automatically failure. */
export type ActionFields = Partial<Record<'modifiers' | 'toolCode' | 'hitCount' | 'hitDepth' | 'selectionBefore' | 'selectionAfter' | 'targetCount' | 'lockedCount' | 'commandCode' | 'inputSamples' | 'sampleUpdates' | 'coalescedSamples' | 'thresholdPassed' | 'motionObserved' | 'snapEnabled' | 'snapChanged' | 'constraintChanged' | 'constraintEnabled' | 'proposalChanged' | 'resolvedChanged' | 'committedChanged' | 'intentResolvedComparison' | 'resolvedCommittedComparison' | 'proposalResolvedComparison' | 'selectionChanged' | 'routeSupported' | 'geometrySupported' | 'inputPhase' | 'fieldFamily' | 'inputValid' | 'expectedWidthComparison' | 'expectedHeightComparison' | 'aspectRatioComparison' | 'layoutConstraintAccepted' | 'poseSubmittedSequence' | 'posePresentedSequence' | 'poseFallbackReason' | 'poseLatencyMs', number | boolean>>
const limits: Record<keyof ActionFields, number> = { modifiers: 15, toolCode: 64, hitCount: 1e6, hitDepth: 1e6, selectionBefore: 1e6, selectionAfter: 1e6, targetCount: 1e6, lockedCount: 1e6, commandCode: 1024, inputSamples: 1e9, sampleUpdates: 1e9, coalescedSamples: 1e9, thresholdPassed: 1, motionObserved: 1, snapEnabled: 1, snapChanged: 1, constraintChanged: 1, constraintEnabled: 1, proposalChanged: 1, resolvedChanged: 1, committedChanged: 1, intentResolvedComparison: 3, resolvedCommittedComparison: 3, proposalResolvedComparison: 3, selectionChanged: 1, routeSupported: 1, geometrySupported: 1, inputPhase: 9, fieldFamily: 11, inputValid: 1, expectedWidthComparison: 3, expectedHeightComparison: 3, aspectRatioComparison: 3, layoutConstraintAccepted: 1, poseSubmittedSequence: 1e9, posePresentedSequence: 1e9, poseFallbackReason: 9, poseLatencyMs: 600000 }
const limitEntries = Object.entries(limits)
export function sanitizeActionFields(input: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, max] of limitEntries) {
    let value: unknown
    try { value = (input as Record<string, unknown>)[key] } catch { continue }
    const n = typeof value === 'boolean' ? Number(value) : value
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max) out[key] = n
  }
  return out
}
const safeCount = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : 0
const safeDuration = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1e9, value)) : 0
type Context = { session: number; revision: number }
type Row = { actionId: number; actionCode: number; actionSource: number; actionSession: number; actionStartRevision: number; actionFinalRevision?: number; actionPhase: number; actionOutcome: number; actionReason: number; actionDurationMs: number; [key: string]: number | undefined }
type Pending = { row: Row; started: number }
export class CanvasActionDiagnostics {
  private serial = 0
  private pending = new Map<number, Pending>()
  private ring: Row[] = []
  private session: number | undefined
  private dropped = 0
  private pendingEvicted = 0
  constructor(readonly enabled: boolean, readonly detail: boolean, private readonly sink: (row: Row) => void, private readonly now = () => performance.now(), private readonly capacity = 128) { if (!Number.isInteger(capacity) || capacity < 1 || capacity > 512) throw new RangeError('Invalid action diagnostic capacity') }
  private output(row: Row) {
    if (this.detail && this.ring.length >= this.capacity) { this.ring.shift(); this.dropped = Math.min(1e9, this.dropped + 1) }
    const output = { ...row, actionRingDropped: this.dropped, actionPendingEvicted: this.pendingEvicted }
    try { this.sink(output) } catch { /* Never reject an action because telemetry failed. */ }
    if (this.detail) this.ring.push({ ...output })
  }
  begin(code: ActionCode, source: ActionSourceCode, context: Context, fields?: ActionFields): number {
    if (!this.enabled) return 0
    if (this.session !== undefined && this.session !== context.session) this.retire(ActionReason.sessionEnd)
    this.session = context.session
    code = Object.values(CanvasAction).includes(code) ? code : CanvasAction.unknown
    source = Object.values(ActionSource).includes(source) ? source : ActionSource.unknown
    context = { session: safeCount(context.session), revision: safeCount(context.revision) }
    const id = ++this.serial, started = this.now()
    const row: Row = { actionId: id, actionCode: code, actionSource: source, actionSession: context.session, actionStartRevision: context.revision, actionPhase: 1, actionOutcome: 0, actionReason: 0, actionDurationMs: 0, ...sanitizeActionFields(fields) }
    if (this.pending.size >= this.capacity) { this.pendingEvicted = Math.min(1e9, this.pendingEvicted + 1); const oldest = this.pending.keys().next().value!; this.finish(oldest, ActionOutcome.cancelled, context, ActionReason.superseded) }
    this.pending.set(id, { row, started }); this.output(row); return id
  }
  sample(id: number, fields?: ActionFields) { const p = this.pending.get(id); if (!p) return; Object.assign(p.row, sanitizeActionFields(fields)); p.row.sampleUpdates = Math.min(1e9, (p.row.sampleUpdates || 0) + 1) }
  finish(id: number, outcome: ActionOutcomeCode, context: Context, reason: ActionReasonCode = 0, fields?: ActionFields) {
    const p = this.pending.get(id); if (!p) return
    this.pending.delete(id)
    context = { session: safeCount(context.session), revision: safeCount(context.revision) }
    outcome = Object.values(ActionOutcome).includes(outcome) ? outcome : ActionOutcome.unsupported
    reason = Object.values(ActionReason).includes(reason) ? reason : ActionReason.unsupported
    if (outcome === ActionOutcome.committed && context.revision <= p.row.actionStartRevision) outcome = ActionOutcome.unchanged
    const sameSession = context.session === p.row.actionSession
    this.output({ ...p.row, ...sanitizeActionFields(fields), actionPhase: 2,
      actionOutcome: sameSession ? outcome : ActionOutcome.cancelled,
      actionReason: sameSession ? reason : ActionReason.staleSession,
      actionFinalRevision: sameSession ? context.revision : undefined,
      actionDurationMs: safeDuration(this.now() - p.started) })
  }
  retire(reason: ActionReasonCode) { for (const [id, p] of this.pending) this.finish(id, ActionOutcome.cancelled, {session: p.row.actionSession, revision: p.row.actionStartRevision}, reason) }
  snapshot() { return { pending: this.pending.size, dropped: this.dropped, pendingEvicted: this.pendingEvicted, rows: this.ring.map(row => ({ ...row })) } }
}
type EditorContext = { sessionGeneration: number; state: { version: number; selection: string[]; doc: object } }
let nextOwner = Math.floor(Math.random() * 1e11)
const collectors = new WeakMap<EditorContext, ReturnType<typeof create>>()
function create(editor: EditorContext) {
  const host = typeof window === 'undefined' ? undefined : (window as unknown as {coreDesktop?:{renderDiagnostics?:boolean;renderDiagnosticsDetail?:boolean}}).coreDesktop
  const owner = ++nextOwner
  const terminal = createRenderDiagnostics({ enabled: host?.renderDiagnostics === true, detail: host?.renderDiagnosticsDetail === true, session: owner, source: 'main', sink: row => console.log(PREFIX + JSON.stringify(row)), batchSink: batch => console.log(PREFIX + JSON.stringify({batch})) })
  const collector = new CanvasActionDiagnostics(terminal.enabled, terminal.detail, row => {
    const correlation = row.actionFinalRevision !== undefined && row.actionFinalRevision > row.actionStartRevision ? operationCorrelation(editor.state.doc) : {}
    terminal.record('canvas-action', { actionOwner: owner, ...row, ...(correlation.authoredRevision === row.actionFinalRevision ? correlation : {}) })
  })
  const context = () => ({ session: editor.sessionGeneration, revision: editor.state.version })
  const cpu = createCpuStageDiagnostics(terminal.enabled, fields => terminal.record('cpu-stage', { actionOwner: owner, actionSession: editor.sessionGeneration, documentRevision: editor.state.version, ...fields }))
  return { enabled: collector.enabled, cpu, begin: (code: ActionCode, source: ActionSourceCode, fields?: ActionFields) => collector.begin(code, source, context(), fields),
    sample: (id: number, fields?: ActionFields) => collector.sample(id, fields),
    finish: (id: number, outcome: ActionOutcomeCode, reason: ActionReasonCode = 0, fields?: ActionFields) => collector.finish(id, outcome, context(), reason, fields),
    event: (code: ActionCode, source: ActionSourceCode, outcome: ActionEventOutcomeCode, reason: ActionReasonCode = 0, fields?: ActionFields) => { const id = collector.begin(code, source, context(), fields); collector.finish(id, outcome, context(), reason) },
    close: () => { collector.retire(ActionReason.sessionEnd); terminal.flush(); terminal.close() }, snapshot: () => collector.snapshot() }
}
export function canvasActions(editor: EditorContext) { let trace = collectors.get(editor); if (!trace) { trace = create(editor); collectors.set(editor, trace) } return trace }
export function modifierBits(event: {shiftKey:boolean;altKey:boolean;ctrlKey:boolean;metaKey:boolean}) { return Number(event.shiftKey) | Number(event.altKey)<<1 | Number(event.ctrlKey)<<2 | Number(event.metaKey)<<3 }

export function closeCanvasActions(editor: EditorContext) { collectors.get(editor)?.close(); collectors.delete(editor) }
