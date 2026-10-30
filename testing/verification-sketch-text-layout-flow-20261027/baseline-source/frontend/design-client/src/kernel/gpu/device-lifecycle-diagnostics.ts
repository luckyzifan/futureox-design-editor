import { recordGpuDiagnostic } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'

/** Process-local diagnostic identity only. Never an adapter/hardware identifier,
 * resource handle, ownership token, or proof of GPU completion. */
export type DeviceDiagnosticFields = Record<string, number>
export const deviceLifecyclePhase = {
  created: 1, attached: 2, lost: 3, callbackDiscarded: 4, parked: 5,
  reviveStart: 6, reviveReady: 7, reviveFailed: 8, disposed: 9,
  recoveryStart: 10, recoveryReady: 11, recoveryFailed: 12, recoveryRetired: 13, recoveryNotHandled: 14,
} as const
// Ephemeral worker scope prevents client-session reuse from conflating restarted workers.
// Probabilistic diagnostic correlation only, never an ownership/security token.
const deviceWorkerScope = Math.floor(Math.random() * 0xffffffffffff) + 1
let nextDevice = 0, nextOwner = 0, nextRecovery = 0
const devices = new WeakMap<object, number>()
const owners = new WeakMap<object, DeviceDiagnosticFields>()
export function registerDeviceDiagnosticOwner(owner: object, device: object, scope: 1 | 2) {
  let deviceIncarnation = devices.get(device)
  if (deviceIncarnation === undefined) { deviceIncarnation = ++nextDevice; devices.set(device, deviceIncarnation) }
  const previous = owners.get(owner)
  if (previous?.deviceIncarnation === deviceIncarnation && previous.deviceScope === scope) return { ...previous }
  const fields = { deviceWorkerScope, deviceIncarnation, deviceOwner: ++nextOwner, deviceScope: scope }
  owners.set(owner, fields)
  return { ...fields }
}
export function deviceDiagnosticFields(owner?: object): DeviceDiagnosticFields {
  return { ...(owner && owners.get(owner)) }
}
// Capture the initiating request before an asynchronous fence. This provider is
// observation-only and cannot make a queue operation fail.
let requestContext: (() => number) | undefined
export function setDeviceDiagnosticRequestContext(read?: () => number) { requestContext = read }
export function captureDeviceDiagnosticRequest(): DeviceDiagnosticFields {
  try {
    const requestId = requestContext?.()
    return Number.isSafeInteger(requestId) && requestId! >= 0 ? { requestId: requestId! } : {}
  } catch { return {} }
}
export function nextDeviceRecoveryId() { return ++nextRecovery }
export function deviceLostReason(reason: unknown) { return reason === 'destroyed' ? 2 : 1 }
/** Observers must never replace a GPU error or interrupt cleanup. Existing
 * recordGpuDiagnostic callers have their own policy; keep this guard local. */
export function recordDeviceDiagnostic(event: 'device-lifecycle' | 'fence' | 'gpu-submit' | 'gpu-retirement', fields: DeviceDiagnosticFields) {
  try { recordGpuDiagnostic(event, { deviceWorkerScope, ...fields }) } catch { /* diagnostic sink only */ }
}
export function recordDeviceLifecycle(owner: object | undefined, phase: number, fields: DeviceDiagnosticFields = {}) {
  recordDeviceDiagnostic('device-lifecycle', { ...deviceDiagnosticFields(owner), devicePhase: phase, ...fields })
}
/** Capture identity when asynchronous work starts. If that owner's identity was
 * replaced, discard only its stale diagnostic attribution, never GPU work. */
export function recordDeviceCallback(owner: object, captured: DeviceDiagnosticFields, phase: number, fields: DeviceDiagnosticFields = {}) {
  const current = deviceDiagnosticFields(owner)
  if (captured.deviceIncarnation !== current.deviceIncarnation || captured.deviceOwner !== current.deviceOwner) {
    recordDeviceDiagnostic('device-lifecycle', { ...captured, devicePhase: deviceLifecyclePhase.callbackDiscarded,
      deviceCallbackDisposition: 4, deviceCurrentIncarnation: current.deviceIncarnation || 0 })
    return
  }
  recordDeviceDiagnostic('device-lifecycle', { ...captured, devicePhase: phase, ...fields })
}

/** Synchronous observation around an EXISTING await/catch boundary. No promise,
 * resource, retry, disposal, or recovery behavior is owned by this token. */
export function beginDeviceRecovery(owner: object | undefined, kind: 1 | 2 | 3 | 4, requestId: number,
  previous: DeviceDiagnosticFields = {}) {
  const captured = deviceDiagnosticFields(owner), deviceRecoveryId = nextDeviceRecoveryId()
  const common = { ...previous, ...captured, deviceRecoveryId, deviceRecoveryKind: kind, requestId }
  recordDeviceDiagnostic('device-lifecycle', { ...common, devicePhase: deviceLifecyclePhase.recoveryStart })
  let ended = false
  return {
    end(phase: typeof deviceLifecyclePhase.recoveryReady | typeof deviceLifecyclePhase.recoveryFailed | typeof deviceLifecyclePhase.recoveryRetired | typeof deviceLifecyclePhase.recoveryNotHandled, resultOwner?: object) {
      if (ended) return
      ended = true
      const next = deviceDiagnosticFields(resultOwner)
      recordDeviceDiagnostic('device-lifecycle', { ...common, ...next,
        ...(captured.deviceIncarnation ? { devicePreviousIncarnation: captured.deviceIncarnation } : {}), devicePhase: phase })
    },
  }
}
