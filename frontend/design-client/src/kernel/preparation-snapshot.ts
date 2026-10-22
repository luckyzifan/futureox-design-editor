import { documentCapacity } from '../document-capacity'
import { applyDocumentPatch, type DocumentPatch } from '../document-patch'
import type { DesignDocument } from '../model'

type Source = { json: string; patches: string[]; patchBytes: number }
/** Full-content proof, never document IDs or hashes. Keep only a bounded
 * ordered journal between forks; no parsed 19k-node JS scene stays resident. */
export class PreparationSnapshots {
  private sources = new Map<string, Source>()
  private mips = new Map<string, boolean>()
  private epochs = new Map<string, number>()
  private static get maxSourceCodeUnits() { return documentCapacity().documentBytes }
  private static readonly maxPatches = 256
  // UTF-16 storage upper bound. Overflow revokes reuse, never document updates.
  private static readonly maxPatchBytes = 4 * 1024 * 1024
  initialize(lane: string, mips: boolean) { if (lane === 'canvas' || lane === 'interaction') this.mips.set(lane, mips) }
  imageMips(lane: string) { return this.mips.get(lane) === true }
  loaded(lane: string, json: string) {
    this.invalidate(lane)
    if (lane === 'canvas' && typeof json === 'string' && json.length <= PreparationSnapshots.maxSourceCodeUnits)
      this.sources.set(lane, { json, patches: [], patchBytes: 0 })
  }
  invalidate(lane: string) {
    if (lane !== 'canvas' && lane !== 'interaction') return
    this.sources.delete(lane); this.epochs.set(lane, (this.epochs.get(lane) ?? 0) + 1)
  }
  /** Revoke before the kernel call; publish the journal only after success. */
  beginPatch(lane: string, json: string): () => void {
    const source = this.sources.get(lane)
    this.invalidate(lane)
    if (lane !== 'canvas' || !source || typeof json !== 'string' ||
      source.patches.length >= PreparationSnapshots.maxPatches ||
      source.patchBytes + json.length * 2 > PreparationSnapshots.maxPatchBytes) return () => {}
    const epoch = this.epochs.get(lane)
    let committed = false
    return () => {
      if (committed || this.epochs.get(lane) !== epoch) return
      committed = true
      this.sources.set(lane, { json: source.json, patches: [...source.patches, json], patchBytes: source.patchBytes + json.length * 2 })
    }
  }
  canFork(lane: string, json: string) {
    if (lane !== 'interaction' || typeof json !== 'string' || !this.mips.has('canvas') ||
      !this.mips.has(lane) || this.mips.get('canvas') !== this.mips.get(lane)) return false
    const source = this.sources.get('canvas')
    if (!source) return false
    try {
      if (source.patches.length) {
        let document = JSON.parse(source.json) as DesignDocument
        // JS must not silently normalize a raw -0/noncanonical source into
        // another kernel source. Ordinary UI JSON.stringify input passes.
        if (!document.nodes || JSON.stringify(document) !== source.json) { this.invalidate('canvas'); return false }
        const patches = source.patches.map(value => JSON.parse(value) as DocumentPatch)
        if (patches.some((patch, index) => !patch.nodes || !patch.fields || JSON.stringify(patch) !== source.patches[index])) { this.invalidate('canvas'); return false }
        // Existing-node replacements commute except for their last value.
        // Preserve every structural/field edit in order; never coalesce adds,
        // deletes or field removal/reinsertion (JSON property order matters).
        if (patches.every(patch => Object.keys(patch.fields).length === 0 &&
          Object.entries(patch.nodes).every(([id, node]) => node !== null && Object.hasOwn(document.nodes, id)))) {
          const nodes = Object.create(null) as DocumentPatch['nodes']
          for (const patch of patches) Object.assign(nodes, patch.nodes)
          document = applyDocumentPatch(document, { nodes, fields: {} })
        } else for (const patch of patches) document = applyDocumentPatch(document, patch)
        const current = JSON.stringify(document)
        if (current.length > PreparationSnapshots.maxSourceCodeUnits) { this.invalidate('canvas'); return false }
        // Release the parsed scene and journal after this call. Retain only
        // one exact source string, including on a mismatched interaction query.
        const matches = current === json
        this.sources.set('canvas', { json: matches ? json : current, patches: [], patchBytes: 0 })
        return matches
      }
      return source.json === json
    } catch { this.invalidate('canvas'); return false }
  }
}
