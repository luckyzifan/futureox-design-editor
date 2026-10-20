import { createRenderDiagnostics, PREFIX } from '../../design-desktop/src/render-terminal-diagnostics.mjs'
import { CanvasOperationDiagnostics, type OperationRecord } from './canvas-operation-diagnostics'
let nextOperationOwner = Math.floor(Math.random() * 1e11)
const committedOperations = new WeakMap<object, Record<string, number>>()
/** Capture at render intent time, before asynchronous serialization. Empty means unobserved. */
export function operationCorrelation(document: object): Record<string, number> { return { ...committedOperations.get(document) } }
const categoryCodes = { other: 0, move: 1, resize: 2, text: 3, property: 4, undo: 5, redo: 6 } as const
const outcomeCodes = { pending: 0, committed: 1, cancelled: 2, unchanged: 3, rejected: 4, 'session-ended': 5 } as const
export function operationTerminalFields(phase: number, record: Readonly<OperationRecord>) {
  return { operationId: record.operation, operationSession: record.session, operationPhase: phase,
    operationPresentation: record.presentation === 'exact-snapshot-acknowledged' ? 1 : 0,
    operationCategory: categoryCodes[record.category], operationOutcome: outcomeCodes[record.outcome],
    startRevision: record.startRevision, ...(record.authoredRevision === null ? {} : { authoredRevision: record.authoredRevision }),
    targetCount: record.targetCount, previewAttempts: record.previewAttempts, previewAccepted: record.previewAccepted }
}
/** Uses the existing dev terminal bridge and bounded diagnostics flush. No pointer-event logging. */
export function createCanvasOperationDiagnostics() {
  const host = typeof window === 'undefined' ? undefined : (window as unknown as {coreDesktop?: {renderDiagnostics?: boolean; renderDiagnosticsDetail?: boolean}}).coreDesktop
  const detail = host?.renderDiagnosticsDetail === true
  const operationOwner = ++nextOperationOwner
  const terminal = createRenderDiagnostics({ enabled: host?.renderDiagnostics === true, detail,
    session: operationOwner, source: 'main',
    sink: record => console.log(PREFIX + JSON.stringify(record)),
    batchSink: batch => console.log(PREFIX + JSON.stringify({ batch })),
  })
  const diagnostics = new CanvasOperationDiagnostics(128, (phase, record, document) => {
    if (phase === 2 && record.outcome === 'committed' && document && record.authoredRevision !== null)
      committedOperations.set(document, { operationOwner, operationId: record.operation, operationSession: record.session, authoredRevision: record.authoredRevision })
    terminal.record('operation', { operationOwner, ...operationTerminalFields(phase, record) })
  }, () => { terminal.flush(); terminal.close() })
  diagnostics.enableDetail(detail)
  return diagnostics
}
