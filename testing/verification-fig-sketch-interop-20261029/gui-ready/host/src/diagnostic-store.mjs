/** No arbitrary message, stack, URL, path, or payload fields enter this store. */
export const DIAGNOSTIC_LIMIT = 256
export const DIAGNOSTIC_BYTES = 128 * 1024
const components = new Set(['runtime', 'react', 'storage', 'workspace', 'import', 'export', 'render', 'automation', 'desktop'])
const codes = new Set(['UNCAUGHT_ERROR', 'UNHANDLED_REJECTION', 'REACT_ERROR', 'STORAGE_ERROR', 'QUOTA_EXCEEDED', 'NETWORK_ERROR', 'TIMEOUT', 'ABORTED', 'INVALID_DATA', 'PERMISSION_DENIED', 'NOT_FOUND', 'OUT_OF_MEMORY', 'DEVICE_LOST', 'OPERATION_FAILED'])
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER - 1) : 0
export function classifyDiagnostic(error) {
  try {
  const name = typeof error?.name === 'string' ? error.name : ''
  const code = typeof error?.code === 'string' ? error.code : ''
  if (codes.has(code)) return code
  const native = {BACKEND_TIMEOUT:'TIMEOUT', BACKEND_UNAVAILABLE:'STORAGE_ERROR', WORKSPACE_UNAVAILABLE:'STORAGE_ERROR', WORKSPACE_INVALID:'INVALID_DATA', WORKSPACE_NOT_FOUND:'NOT_FOUND', WORKSPACE_LIMIT:'QUOTA_EXCEEDED', INVALID_DOCUMENT:'INVALID_DATA', STALE_DIRECTORY:'PERMISSION_DENIED'}
  if (Object.hasOwn(native, code)) return native[code]
  const names = {QuotaExceededError:'QUOTA_EXCEEDED', NetworkError:'NETWORK_ERROR', TimeoutError:'TIMEOUT', AbortError:'ABORTED', SyntaxError:'INVALID_DATA', NotAllowedError:'PERMISSION_DENIED', SecurityError:'PERMISSION_DENIED', NotFoundError:'NOT_FOUND'}
  return Object.hasOwn(names, name) ? names[name] : 'OPERATION_FAILED'
  } catch { return 'OPERATION_FAILED' }
}
export function sanitizeDiagnostic(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null
  return {
    time: Number.isFinite(value.time) && value.time >= 0 && value.time <= now + 60000 ? value.time : now,
    severity: ['error', 'warning'].includes(value.severity) ? value.severity : 'error',
    component: components.has(value.component) ? value.component : 'runtime',
    code: codes.has(value.code) ? value.code : 'OPERATION_FAILED',
    requestId: /^diag-[a-f0-9]{16}-[0-9]{1,12}$/.test(value.requestId) ? value.requestId : undefined,
  }
}
export function parseDiagnostics(raw) {
  if (typeof raw !== 'string' || raw.length > DIAGNOSTIC_BYTES) throw new Error('Invalid diagnostic storage')
  const value = JSON.parse(raw)
  if (value?.schema !== 1 || !Array.isArray(value.records) || value.records.length > DIAGNOSTIC_LIMIT) throw new Error('Invalid diagnostic schema')
  return {schema:1, dropped:count(value.dropped), records:value.records.map(row => sanitizeDiagnostic(row)).filter(Boolean)}
}
export function createDiagnosticStore({adapter, now = Date.now, random = () => globalThis.crypto.getRandomValues(new Uint32Array(2)), delay = 250} = {}) {
  let records = [], dropped = 0, status = 'loading', timer, inFlight, dirty = false, loaded = false
  let sequence = 0
  const session = Array.from(random(), value => value.toString(16).padStart(8, '0')).join('').slice(0,16)
  const listeners = new Set()
  let snapshot = {records, dropped, status}
  const notify = () => { snapshot = {records:records.slice(), dropped, status}; for (const listener of listeners) { try { listener() } catch {} } }
  const trim = () => { if (records.length > DIAGNOSTIC_LIMIT) { dropped = count(dropped + records.length - DIAGNOSTIC_LIMIT); records = records.slice(-DIAGNOSTIC_LIMIT) } }
  const serialize = () => JSON.stringify({schema:1, dropped, records})
  const schedule = () => { if (loaded && !timer && !inFlight) timer = setTimeout(() => { timer = undefined; void flush() }, delay) }
  const ready = Promise.resolve().then(() => adapter?.read()).then(raw => {
    if (raw != null) { const prior = parseDiagnostics(raw); records = [...prior.records, ...records]; dropped = count(dropped + prior.dropped); trim() }
    status = dirty ? 'pending' : adapter ? 'saved' : 'session-only'
  }).catch(() => { status = 'session-only' }).finally(() => { loaded = true; notify(); if (dirty) schedule() })
  async function flush() {
    await ready
    if (timer) { clearTimeout(timer); timer = undefined }
    if (inFlight) { await inFlight; if (dirty) return flush(); return }
    if (!dirty) return
    dirty = false
    const data = serialize()
    inFlight = Promise.resolve().then(() => { if (!adapter) throw new Error('No storage'); return adapter.write(data) })
      .then(() => { status = dirty ? 'pending' : 'saved' }).catch(() => { status = 'session-only' }).finally(() => { inFlight = undefined; notify() })
    await inFlight
    if (dirty) schedule()
  }
  return {
    ready, flush,
    record(value) {
      const requestId = `diag-${session}-${++sequence}`
      const row = sanitizeDiagnostic({...value, time:now(), requestId}, now())
      records = [...records, row]; trim(); dirty = true; status = 'pending'; notify(); schedule(); return requestId
    },
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    exportJSON: () => JSON.stringify({schema:1, exportedAt:now(), dropped, records}, null, 2),
  }
}
export function browserDiagnosticAdapter(storage) {
  const key = 'forma-local-errors-v1'
  return { read: () => storage().getItem(key), write: value => storage().setItem(key, value) }
}
export function installDiagnosticHooks(target, store) {
  const error = event => store.record({component:'runtime', code:classifyDiagnostic(event.error) === 'OPERATION_FAILED' ? 'UNCAUGHT_ERROR' : classifyDiagnostic(event.error)})
  const rejection = event => store.record({component:'runtime', code:classifyDiagnostic(event.reason) === 'OPERATION_FAILED' ? 'UNHANDLED_REJECTION' : classifyDiagnostic(event.reason)})
  const flush = () => { void store.flush() }
  target.addEventListener('error', error); target.addEventListener('unhandledrejection', rejection); target.addEventListener('pagehide', flush)
  return () => { target.removeEventListener('error', error); target.removeEventListener('unhandledrejection', rejection); target.removeEventListener('pagehide', flush) }
}
