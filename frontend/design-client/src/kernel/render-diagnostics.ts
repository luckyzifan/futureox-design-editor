/** Privacy-safe companion to render-profile's stage timings.
 * Recording is opt-in, in-memory and bounded. Only allowlisted scalar values
 * enter the journal: never document/node IDs, image URIs, payloads or raw
 * exception text. Density means sample pixels per world unit (zoom × DPR),
 * not the canvas backing-store DPR. Timings may overlap; do not sum them. */
export type RenderDiagnosticKind = 'request' | 'tile' | 'present' | 'cache' | 'error'
export type RenderDiagnosticError = 'budget' | 'device-lost' | 'cancelled' | 'timeout' | 'unknown'
export type RenderDiagnosticInput = {
  kind: RenderDiagnosticKind
  zoom?: number; dpr?: number; requestedDensity?: number; sampledDensity?: number; publishedDensity?: number
  cacheHits?: number; cacheMisses?: number
  totalMs?: number; compileMs?: number; graphMs?: number; finishMs?: number; checkpointMs?: number
  errorCode?: RenderDiagnosticError
}
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
  if (/budget|预算|内存.*超限/i.test(message)) return 'budget'
  if (/cancel|abort|supersed|取消/i.test(message)) return 'cancelled'
  if (/timed? ?out|timeout|超时/i.test(message)) return 'timeout'
  return 'unknown'
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
      samples.push(Object.freeze(sample))
      if (samples.length > capacity) { samples.shift(); dropped++ }
    },
  }
}

export const renderDiagnostics = createRenderDiagnostics()
export const recordRenderDiagnostic = (input: RenderDiagnosticInput) => renderDiagnostics.record(input)
