const limits = Object.entries({ failureMaterialFieldBuilds:1e9,failureMaterialFieldUploadBytes:1e12,
  failureImageAxisFields:1e9,failureImageFieldBytes:1e12, failureAllocationSnapshotVersion: 1, failureAllocationKind: 12,
  failureBuildKind: 9, failureLedgerTotalBytes: 17179869184,
  failureLedgerInteractionBytes: 17179869184, failureLedgerNestedPrefixBytes: 17179869184,
  failureLedgerDriverScratchBytes: 17179869184, failureLedgerMaterialFieldBytes: 17179869184,
  failureLedgerCoverageBytes: 17179869184, failureLedgerKernelBytes: 17179869184,
  failureLedgerBusyCount: 1000000, failureLedgerImageCount: 1000000,
  failureLedgerAtlasPageCount: 1000000, failureLedgerRetiredUploadCount: 1000000,
  failureLedgerCoordinateCount: 1000000 })
export function sanitizeFailureAllocation(value) {
  const out = {}
  try {
    if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, 'failureAllocationSnapshotVersion')?.value !== 1) return out
    for (const [key, maximum] of limits) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value
      if (Number.isSafeInteger(item) && item >= 0 && item <= maximum) out[key] = item
    }
  } catch { return {} }
  return out
}
const snapshots = new WeakMap()
const object = value => (typeof value === 'object' && value !== null) || typeof value === 'function'
export function markFailureAllocation(error, fields) {
  if (object(error)) snapshots.set(error, Object.freeze(sanitizeFailureAllocation(fields)))
  return error
}
export function failureAllocationFields(error) { return object(error) ? { ...snapshots.get(error) } : {} }
export function inheritFailureAllocation(source, target) {
  if (object(source) && object(target) && snapshots.has(source)) snapshots.set(target, snapshots.get(source))
  return target
}
