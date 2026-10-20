import { createRenderDiagnostics, PREFIX } from '../../design-desktop/src/render-terminal-diagnostics.mjs'

/** Numeric phases only. No names, IDs, paths, document bytes, or exception text.
 * Timings are wall clock and nested/async spans overlap; never add them together. */
export const DocumentStage = {
  read: 201, decode: 202, admission: 203, layout: 204, derivedValidation: 205,
  adoption: 206, recoveryWait: 207, encode: 208, leave: 209, freshRead: 210,
  reuse: 211, prepare: 212, save: 213, recovery: 214,
} as const
let serial = 0
let collector: ReturnType<typeof createRenderDiagnostics> | undefined
function begin(stage: number, sourceCodeUnits = 0) {
  const host = typeof window === 'undefined' ? undefined : (window as unknown as { coreDesktop?: { renderDiagnostics?: boolean; renderDiagnosticsDetail?: boolean } }).coreDesktop
  if (host?.renderDiagnostics !== true) return () => {}
  collector ||= createRenderDiagnostics({ enabled: true, detail: host.renderDiagnosticsDetail === true,
    session: Math.floor(Math.random() * 1e11), source: 'main',
    sink: row => console.log(PREFIX + JSON.stringify(row)),
    batchSink: batch => console.log(PREFIX + JSON.stringify({ batch })) })
  const count = ++serial, start = performance.now()
  collector.record('load-stage', { methodCode: stage, count, phase: 1, reasonCode: 0, sourceCodeUnits })
  return (failed = false) => collector!.record('load-stage', { methodCode: stage, count, phase: 2,
    reasonCode: failed ? 2 : 1, durationMs: performance.now() - start, sourceCodeUnits })
}
export function documentStage<T>(stage: number, action: () => T, sourceCodeUnits = 0): T {
  const end = begin(stage, sourceCodeUnits)
  try { const result = action(); end(); return result } catch (error) { end(true); throw error }
}
export async function documentStageAsync<T>(stage: number, action: () => Promise<T>, sourceCodeUnits = 0): Promise<T> {
  const end = begin(stage, sourceCodeUnits)
  try { const result = await action(); end(); return result } catch (error) { end(true); throw error }
}
