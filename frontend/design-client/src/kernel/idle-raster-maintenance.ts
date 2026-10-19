type Cancel = () => void
export type MaintenanceDriver = {
  delay: (run: () => void) => Cancel
  idle: (run: () => void) => Cancel
}
const browserDriver: MaintenanceDriver = {
  delay(run) {
    const id = setTimeout(run, 250)
    return () => clearTimeout(id)
  },
  idle(run) {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run)
      return () => cancelIdleCallback(id)
    }
    const id = requestAnimationFrame(run)
    return () => cancelAnimationFrame(id)
  },
}

/** Optional cache maintenance never owns the visible frame's critical path.
 * Admit one tile after a quiet interval and an idle opportunity, then yield
 * again. Cancellation drops queued work; an already running WASM call can
 * finish, but it cannot start the next tile for an obsolete camera. */
export function scheduleRasterMaintenance<T>(
  jobs: readonly T[],
  submit: (job: T) => Promise<unknown>,
  current: () => boolean,
  onError: (error: unknown) => void,
  driver: MaintenanceDriver = browserDriver,
): Cancel {
  let cancelled = false, index = 0, cancelPending: Cancel | undefined
  const live = () => !cancelled && current()
  const schedule = () => {
    if (!live() || index === jobs.length) return
    cancelPending = driver.delay(() => {
      cancelPending = undefined
      if (!live()) return
      cancelPending = driver.idle(() => {
        cancelPending = undefined
        if (!live()) return
        void Promise.resolve().then(() => live() ? submit(jobs[index++]) : undefined).then(schedule, error => {
          if (live() && !String(error).includes('PREVIEW_CANCELLED')) onError(error)
        })
      })
    })
  }
  schedule()
  return () => { cancelled = true; cancelPending?.(); cancelPending = undefined }
}
