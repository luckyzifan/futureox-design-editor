/** Synchronous, content-free CPU spans. Opt-in only; never carry a document,
 * node ID, geometry, payload, or error text. Nested durations overlap.
 * This is wall-clock attribution, not sampled CPU or input-to-photon timing. */
export const CpuStage = {
  pointerQueue: 1, pointerMove: 2, proposal: 3, pointerUp: 4, releaseFlush: 5,
  preview: 10, previewPrepare: 11, previewLayout: 12, previewBounds: 13, previewPublish: 14,
  commit: 20, commitValidate: 21, commitShare: 22, commitHistory: 23, commitPublish: 24,
  serialize: 30, resolveComponents: 31, resolveLayout: 32, parse: 33,
  historyCompile: 34, historyEncode: 35, historyDecode: 36, historyApply: 37,
} as const
export type CpuStageCode = typeof CpuStage[keyof typeof CpuStage]
type Fields = Record<string, number>
type Scope = { run<T>(stage: CpuStageCode, work: () => T, actionId?: number, waitMs?: number): T }
let current: Scope | undefined
/** Deep boundaries participate only while an explicitly traced editor call runs. */
export function measureCpuStage<T>(stage: CpuStageCode, work: () => T): T {
  return current ? current.run(stage, work) : work()
}
export function createCpuStageDiagnostics(enabled: boolean, sink: (fields: Fields) => void, now = () => performance.now()): Scope {
  let serial = 0, windowStart = -Infinity, admitted = 0, skipped = 0
  const stack: { id: number; actionId: number }[] = []
  const emit = (fields: Fields) => { try { sink(fields) } catch { /* Never affect the operation. */ } }
  const clock = () => { try { return now() } catch { return NaN } }
  const scope: Scope = { run<T>(stage: CpuStageCode, work: () => T, actionId = 0, waitMs?: number): T {
    if (!enabled) return work()
    const started = clock()
    if (!Number.isFinite(started)) return work()
    if (started - windowStart >= 1000) { windowStart = started; admitted = 0 }
    // Per-second admission, not a lifetime cap: later gestures still trace.
    if (admitted >= 128 || stack.length >= 16) { skipped = Math.min(1e9, skipped + 1); return work() }
    admitted++
    const parent = stack.at(-1), id = ++serial
    const owner = Number.isSafeInteger(actionId) && actionId > 0 ? actionId : parent?.actionId ?? 0
    const fields = { cpuSpanId: id, cpuParentSpanId: parent?.id ?? 0, cpuStageCode: stage, actionId: owner, cpuSkipped: skipped }
    skipped = 0
    const bounded = (value: number) => Math.min(120000, Math.max(0, value))
    emit({ ...fields, cpuPhase: 1, ...(waitMs !== undefined && Number.isFinite(waitMs) ? { cpuWaitMs: bounded(waitMs) } : {}) })
    const previous = current
    current = scope; stack.push({ id, actionId: owner })
    let completed = false
    try { const value = work(); completed = true; return value }
    finally {
      stack.pop(); current = previous
      const elapsed = clock() - started
      emit({ ...fields, cpuPhase: 2,
        ...(Number.isFinite(elapsed) && elapsed >= 0 ? { cpuDurationMs: bounded(elapsed), cpuDurationCapped: Number(elapsed > 120000) } : {}),
        cpuOutcome: Number(completed) })
    }
  } }
  return scope
}
