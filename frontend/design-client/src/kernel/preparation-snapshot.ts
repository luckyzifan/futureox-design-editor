/** Exact source ownership certificate. Only a successful full load establishes
 * a certificate; any mutation revokes it before executing, including failures.
 * CPU/GPU capabilities and document IDs alone never prove equal content. */
export class PreparationSnapshots {
  private sources = new Map<string, string>()
  private mips = new Map<string, boolean>()
  initialize(lane: string, mips: boolean) { this.mips.set(lane, mips) }
  imageMips(lane: string) { return this.mips.get(lane) === true }
  loaded(lane: string, json: string) { this.sources.set(lane, json) }
  invalidate(lane: string) { this.sources.delete(lane) }
  canFork(lane: string, json: string) {
    return lane === 'interaction' && typeof json === 'string' && this.sources.has('canvas') && this.sources.get('canvas') === json &&
      this.mips.has('canvas') && this.mips.has(lane) && this.mips.get('canvas') === this.mips.get(lane)
  }
}
