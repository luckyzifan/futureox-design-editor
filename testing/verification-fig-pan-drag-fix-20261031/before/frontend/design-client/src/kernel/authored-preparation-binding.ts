import type { PreparationStateReceiptV1 } from './preparation-state'

/** This is authored identity proof, not a packet receipt or a client revision.
 * Only a successful full synchronization or a verified acknowledged patch
 * from the exact bound predecessor may establish it. */
export class AuthoredPreparationBinding<T extends object> {
  private epoch = 0
  private binding?: { document: T; receipt: PreparationStateReceiptV1 }
  invalidate() { this.epoch++; this.binding = undefined }
  capture(document: T) {
    const epoch = this.epoch
    return (receipt: PreparationStateReceiptV1 | null | undefined) => {
      if (epoch === this.epoch && receipt?.lane === 'canvas') this.binding = { document, receipt }
    }
  }
  receiptFor(document: T): PreparationStateReceiptV1 | undefined {
    return this.binding?.document === document ? this.binding.receipt : undefined
  }
}

export function samePreparationReceipt(a: PreparationStateReceiptV1 | null | undefined, b: PreparationStateReceiptV1 | null | undefined): boolean {
  return !!a && !!b && a.protocol === 1 && b.protocol === 1 &&
    a.sessionGeneration === b.sessionGeneration && a.canvasOwner === b.canvasOwner &&
    a.documentIncarnation === b.documentIncarnation && a.lane === b.lane &&
    a.synchronizedRevision === b.synchronizedRevision && a.resourceEpoch === b.resourceEpoch && a.nonce === b.nonce
}
