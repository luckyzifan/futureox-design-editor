import type { Editor } from './engine'
import { canvasActions, CanvasAction, ActionSource, ActionOutcome, ActionReason, type ActionFields, type ActionSourceCode } from './canvas-action-diagnostics'
import { selectionMetric } from './selection-properties'

// Fixed semantic codes only. Labels, input contents, node IDs and geometry never reach the sink.
export const InputPhase = { focus: 1, start: 2, compositionStart: 3, compositionEnd: 4, validity: 5, commit: 6, cancel: 7, blur: 8, scrub: 9 } as const
export const InputFamily = { generic: 1, numeric: 2, width: 3, height: 4, mixed: 5, text: 6, richText: 7, richStyle: 8, color: 9, layerOpacity: 10, paintOpacity: 11 } as const
export function numericInputFamily(label: string) { return label === '透明度 %' ? InputFamily.layerOpacity : label === '不透明度 %' ? InputFamily.paintOpacity : label === 'W' ? InputFamily.width : label === 'H' ? InputFamily.height : InputFamily.numeric }
export function createInputDiagnostics(editor: Editor | null | undefined, family: number, source: ActionSourceCode = ActionSource.properties) {
  const trace = editor ? canvasActions(editor) : undefined
  const action = family === InputFamily.text || family === InputFamily.richText ? CanvasAction.text : CanvasAction.propertyInput
  let token = 0, startRevision = 0
  const fields = (phase: number, extra?: ActionFields): ActionFields => ({ fieldFamily: family, inputPhase: phase, targetCount: editor?.state.selection.length ?? 0, ...extra })
  return {
    event(phase: number, extra?: ActionFields) { trace?.event(action, source, ActionOutcome.observed, ActionReason.none, fields(phase, extra)) },
    start(phase: number = InputPhase.start) { if (!token) { startRevision = editor?.state.version ?? 0; token = trace?.begin(action, source, fields(phase, { selectionBefore: editor?.state.selection.length ?? 0 })) ?? 0 } },
    valid(valid: boolean) { trace?.event(action, source, valid ? ActionOutcome.observed : ActionOutcome.blocked, valid ? ActionReason.none : ActionReason.validation, fields(InputPhase.validity, { inputValid: valid })) },
    finish(changed: boolean, verified: boolean, extra?: ActionFields) {
      // An arbitrary callback returning is not proof of authored state. Callers supply verified state evidence.
      if (!token) return
      verified = verified && (!changed || (!!editor && editor.state.version > startRevision))
      trace?.finish(token, !verified ? ActionOutcome.blocked : changed ? ActionOutcome.committed : ActionOutcome.unchanged, verified ? ActionReason.none : ActionReason.validation, fields(InputPhase.commit, { committedChanged: changed, selectionAfter: editor?.state.selection.length ?? 0, ...extra }))
      token = 0
    },
    dispose() { if (token) trace?.finish(token, ActionOutcome.cancelled, ActionReason.sessionEnd, fields(InputPhase.cancel)); token = 0 },
    cancel(reason = ActionReason.escape) { if (token) trace?.finish(token, ActionOutcome.cancelled, reason, fields(InputPhase.cancel)); token = 0 },
  }
}

/** Transient local comparisons: return flags only, never the values used to compare. */
export function dimensionExpectation(editor: Editor | null | undefined, family: number, intended: number) {
  if (!editor || (family !== InputFamily.width && family !== InputFamily.height)) return () => ({})
  const axis = family === InputFamily.width ? 'width' : 'height'
  const session = editor.sessionGeneration
  const before = editor.state.selection.map(id => {
    const n = editor.state.doc.nodes[id]
    return n ? { id, locked: n.constrainProportions, ratio: selectionMetric(n, 'width', editor.state.doc) / selectionMetric(n, 'height', editor.state.doc) } : null
  })
  return (): ActionFields => {
    if (!before.length || before.some(n => !n) || session !== editor.sessionGeneration) return { geometrySupported: false }
    const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
    const nodes = before.map(n => editor.state.doc.nodes[n!.id])
    if (nodes.some(n => !n)) return { geometrySupported: false }
    const match = nodes.every(n => near(selectionMetric(n, axis, editor.state.doc), intended))
    const constrained = before.some(n => n!.locked)
    const ratioMatches = nodes.every((n, i) => !before[i]!.locked || near(selectionMetric(n, 'width', editor.state.doc) / selectionMetric(n, 'height', editor.state.doc), before[i]!.ratio))
    return { geometrySupported: true, [axis === 'width' ? 'expectedWidthComparison' : 'expectedHeightComparison']: match ? 1 : 2, aspectRatioComparison: constrained ? ratioMatches ? 1 : 2 : 0 }
  }
}
