/** Preserve host error visibility without misrepresenting an accepted commit as
 * retryable failure. Reporting runs after completion/audit in the current stack.
 * Browser reportError emits its normal error event; Node/older hosts receive the
 * original uncaught exception in a microtask. This is not diagnostic payload. */
export function reportPostcommitSubscriberError(error: unknown) {
  queueMicrotask(() => {
    const report = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError
    if (typeof report === 'function') {
      try { report.call(globalThis, error); return } catch { /* Fall back to the original error, not a second reporting error. */ }
    }
    throw error
  })
}
