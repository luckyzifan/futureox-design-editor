/** Privacy-safe companion to render-profile's stage timings.
 * Recording is opt-in, in-memory and bounded. Only allowlisted scalar values
 * enter the journal: never document/node IDs, image URIs, payloads or raw
 * exception text. Density means sample pixels per world unit (zoom × DPR),
 * not the canvas backing-store DPR. Timings may overlap; do not sum them. */
export type RenderDiagnosticKind = 'request' | 'tile' | 'present' | 'cache' | 'error'
export type RenderDiagnosticError = 'budget' | 'device-lost' | 'cancelled' | 'timeout' | 'unknown'
/** Allocation scalars only. Width/height describe the rejected allocation,
 * when known, and never its location or the document's content. */
export type RenderBudgetDiagnostic = Readonly<{
  requestedBytes: number; workingBytes: number; budgetBytes: number
  width?: number; height?: number; coherent?: boolean
}>
export type RenderDiagnosticInput = {
  kind: RenderDiagnosticKind
  zoom?: number; dpr?: number; requestedDensity?: number; sampledDensity?: number; publishedDensity?: number
  cacheHits?: number; cacheMisses?: number
  totalMs?: number; compileMs?: number; graphMs?: number; finishMs?: number; checkpointMs?: number
  errorCode?: RenderDiagnosticError
} & Partial<RenderBudgetDiagnostic>
export type RenderDiagnosticSample = Readonly<RenderDiagnosticInput & { sequence: number; at: number }>
const kinds = new Set<unknown>(['request', 'tile', 'present', 'cache', 'error'])
const errors = new Set<unknown>(['budget', 'device-lost', 'cancelled', 'timeout', 'unknown'])
const positiveFields = ['zoom', 'dpr', 'requestedDensity', 'sampledDensity', 'publishedDensity'] as const
const durationFields = ['totalMs', 'compileMs', 'graphMs', 'finishMs', 'checkpointMs'] as const
const countFields = ['cacheHits', 'cacheMisses'] as const

/** Classification only: the supplied error is inspected, never stored. Bound
 * inspection as well, since errors may embed a large document or data URI. */
export function renderDiagnosticError(error: unknown): RenderDiagnosticError {
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').slice(0, 512)
  if (/device lost|GPU device|设备已丢失|上下文已丢失/i.test(message)) return 'device-lost'
  if (/cancel|abort|supersed|取消/i.test(message)) return 'cancelled'
  if (/budget|预算|内存.*超限/i.test(message)) return 'budget'
  if (/timed? ?out|timeout|超时/i.test(message)) return 'timeout'
  return 'unknown'
}

/** Validate again at each boundary, including worker messages and export.
 * Copy no unknown keys, arrays, text, stack, IDs or coordinates. */
export function sanitizeRenderBudget(input: unknown): RenderBudgetDiagnostic | undefined {
  if (!input || typeof input !== 'object') return
  const source = input as Record<string, unknown>
  const { requestedBytes, workingBytes, budgetBytes } = source
  const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!bytes(requestedBytes) || !bytes(workingBytes) || !bytes(budgetBytes) || budgetBytes === 0 ||
      requestedBytes <= budgetBytes - workingBytes) return
  const result: { requestedBytes: number; workingBytes: number; budgetBytes: number; width?: number; height?: number; coherent?: boolean } =
    { requestedBytes, workingBytes, budgetBytes }
  if (bytes(source.width) && source.width > 0 && bytes(source.height) && source.height > 0) {
    result.width = source.width; result.height = source.height
  }
  if (typeof source.coherent === 'boolean') result.coherent = source.coherent
  return Object.freeze(result)
}

/** Only the error which rejected the allocation owns its summary. Never
 * consult renderer-global state after a cancellation, retry or disposal. */
export function renderBudgetDiagnostic(error: unknown, candidate?: unknown): RenderBudgetDiagnostic | undefined {
  if (renderDiagnosticError(error) !== 'budget') return
  return sanitizeRenderBudget(candidate ?? (error instanceof Error
    ? (error as Error & { budgetDiagnostic?: unknown }).budgetDiagnostic : undefined))
}

/** Preserve safe budget detail through existing message-prefix wrappers.
 * Raw error text remains for UI/recovery behavior but never enters a journal. */
export function renderErrorWithBudget(error: unknown, message?: string, candidate?: unknown): Error {
  const result = new Error(message ?? (error instanceof Error ? error.message : String(error)))
  const budgetDiagnostic = renderBudgetDiagnostic(error, candidate)
  if (budgetDiagnostic && renderDiagnosticError(result) === 'budget')
    Object.defineProperty(result, 'budgetDiagnostic', { value: budgetDiagnostic })
  return result
}

export function renderFailureEnvelope(error: unknown) {
  const budgetDiagnostic = renderBudgetDiagnostic(error)
  return { error: error instanceof Error ? error.message : String(error),
    ...(budgetDiagnostic ? { budgetDiagnostic } : {}) }
}

/** A factory makes the actual recorder deterministic in native Node tests;
 * application code uses the single instance below, controlled by the panel. */
export function createRenderDiagnostics(capacity = 512, now: () => number = () => performance.now()) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 512)
    throw new RangeError('Render diagnostics capacity must be between 1 and 512')
  let recording = false, sequence = 0, dropped = 0
  const samples: RenderDiagnosticSample[] = []
  return {
    start() { samples.length = 0; sequence = 0; dropped = 0; recording = true },
    pause() { recording = false },
    get recording() { return recording },
    snapshot() { return samples.slice() },
    report() {
      return { schema: 1, capacity, dropped, densityUnits: 'sample-pixels-per-world-unit',
        timeUnits: 'ms', timing: 'wall-clock; stages can overlap; not input-to-photon', samples: samples.slice() }
    },
    record(input: RenderDiagnosticInput) {
      if (!recording || !input || !kinds.has(input.kind)) return
      const time = now()
      const sample: RenderDiagnosticInput & { sequence: number; at: number } = {
        kind: input.kind, sequence: ++sequence, at: Number.isFinite(time) && time >= 0 ? time : 0,
      }
      for (const field of positiveFields) {
        const value = input[field]
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) sample[field] = value
      }
      for (const field of durationFields) {
        const value = input[field]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) sample[field] = value
      }
      for (const field of countFields) {
        const value = input[field]
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) sample[field] = value
      }
      if (input.errorCode !== undefined || input.kind === 'error')
        sample.errorCode = errors.has(input.errorCode) ? input.errorCode : 'unknown'
      if (sample.kind === 'error' && sample.errorCode === 'budget') {
        const budget = sanitizeRenderBudget(input)
        if (budget) Object.assign(sample, budget)
      }
      samples.push(Object.freeze(sample))
      if (samples.length > capacity) { samples.shift(); dropped++ }
    },
  }
}

export const renderDiagnostics = createRenderDiagnostics()
export const recordRenderDiagnostic = (input: RenderDiagnosticInput) => renderDiagnostics.record(input)
