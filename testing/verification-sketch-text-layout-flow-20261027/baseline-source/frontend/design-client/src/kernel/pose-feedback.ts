import type { InteractionPoseFeedback } from './interaction-layers'
/** A submitted pose is not a displayed pose. Retain only small offsets, never
 * document snapshots or geometry; acknowledgement ownership is checked by the
 * resident presenter before it enters this ledger. */
export class PoseFeedback {
  private pending = new Map<number, { offset: InteractionPoseFeedback; owner?: object }>()
  private accepted = 0
  submit(sequence: number, offset: InteractionPoseFeedback, owner?: object) {
    this.pending.set(sequence, { offset: { ...offset, ...(offset.matrix ? { matrix: [...offset.matrix] as typeof offset.matrix } : {}) }, owner })
    while (this.pending.size > 180) this.pending.delete(this.pending.keys().next().value!)
  }
  status(sequence:number,owner?:object) {
    if(!Number.isSafeInteger(sequence)||sequence<=this.accepted)return 7
    const record=this.pending.get(sequence)
    return !record?3:record.owner!==owner?2:0
  }
  present(sequence: number, owner?: object) {
    if (!Number.isSafeInteger(sequence) || sequence <= this.accepted) return undefined
    const record = this.pending.get(sequence)
    if (!record || record.owner !== owner) return undefined
    this.accepted = sequence
    for (const key of this.pending.keys()) if (key <= sequence) this.pending.delete(key)
    return record.offset
  }
  clear() { this.pending.clear(); this.accepted = 0 }
}
