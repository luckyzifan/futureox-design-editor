/** Transport-only proof of an acknowledged preparation state, not authored equality. */
export type PreparationStateReceiptV1 = {
  protocol: 1; sessionGeneration: string; canvasOwner: string; documentIncarnation: string
  lane: 'canvas' | 'interaction'; synchronizedRevision: string; resourceEpoch: string; nonce: string
}
export type DeriveDocumentRequestV1 = {
  operationId: number; baseReceipt: PreparationStateReceiptV1; target: 'interaction'
  expectedTarget: PreparationStateReceiptV1 | null; delta: []
}
const fields = ['protocol', 'sessionGeneration', 'canvasOwner', 'documentIncarnation', 'lane', 'synchronizedRevision', 'resourceEpoch', 'nonce'] as const
function same(a: unknown, b: PreparationStateReceiptV1 | null): boolean {
  if (b === null) return a === null
  if (!a || typeof a !== 'object' || Object.keys(a).length !== fields.length) return false
  return fields.every(key => (a as Record<string, unknown>)[key] === b[key])
}
/** One instance per owned worker/port. Never accepts a caller-selected owner. */
export class PreparationStates {
  private owner = crypto.randomUUID()
  private sequence = 0
  private operation = 0
  private receipts = new Map<string, PreparationStateReceiptV1>()
  current(lane: string) { return this.receipts.get(lane) ?? null }
  revoke(lane: string) { const old = this.current(lane); this.receipts.delete(lane); return old }
  mint(lane: 'canvas' | 'interaction', previous: PreparationStateReceiptV1 | null, newDocument = false) {
    if (!Number.isSafeInteger(++this.sequence)) throw Error('PREPARATION_SESSION_EXHAUSTED')
    const serial = String(this.sequence)
    const receipt: PreparationStateReceiptV1 = { protocol: 1, sessionGeneration: this.owner, canvasOwner: this.owner,
      documentIncarnation: newDocument ? serial : previous?.documentIncarnation ?? serial,
      lane, synchronizedRevision: serial, resourceEpoch: serial, nonce: serial }
    this.receipts.set(lane, receipt)
    return receipt
  }
  validatePatch(lane: string, args: unknown[]) {
    if (args.length <= 1) return
    const guard = args[1]
    if (args.length !== 2 || !guard || typeof guard !== 'object' ||
      Object.keys(guard).join(',') !== 'expectedBaseReceipt') throw Error('PATCH_GUARD_SCHEMA')
    const expected = (guard as {expectedBaseReceipt: unknown}).expectedBaseReceipt
    if (!expected || typeof expected !== 'object' || Object.keys(expected).length !== fields.length ||
      !fields.every(key => Object.hasOwn(expected, key)) || (expected as Record<string, unknown>).protocol !== 1 ||
      !fields.filter(key => key !== 'protocol').every(key => typeof (expected as Record<string, unknown>)[key] === 'string')) throw Error('PATCH_GUARD_SCHEMA')
    if (!this.current(lane) || !same(expected, this.current(lane))) throw Error('STALE_BASE')
    if (!Number.isSafeInteger(this.sequence + 1)) throw Error('PREPARATION_SESSION_EXHAUSTED')
  }
  validateDerive(lane: string, args: unknown[]): DeriveDocumentRequestV1 {
    if (!Number.isSafeInteger(this.sequence + 1)) throw Error('PREPARATION_SESSION_EXHAUSTED')
    const request = args[0] as DeriveDocumentRequestV1
    if (lane !== 'interaction' || args.length !== 1 || !request || typeof request !== 'object' ||
      Object.keys(request).sort().join(',') !== 'baseReceipt,delta,expectedTarget,operationId,target' ||
      !Number.isSafeInteger(request.operationId) || request.operationId <= 0 || request.target !== 'interaction' ||
      !Array.isArray(request.delta) || request.delta.length !== 0 || JSON.stringify(request).length > 8192) throw Error('DERIVE_SCHEMA')
    if (request.operationId <= this.operation) throw Error('DERIVE_RETRY_REJECTED')
    this.operation = request.operationId
    if (!this.current('canvas') || !same(request.baseReceipt, this.current('canvas'))) throw Error('STALE_BASE')
    if (!same(request.expectedTarget, this.current('interaction'))) throw Error('STALE_TARGET')
    return request
  }
}
