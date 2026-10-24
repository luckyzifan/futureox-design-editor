import { documentPatch } from './document-patch'
import type { DesignDocument } from './model'

export type CodecDelta = {
  owner: string; base: number; sequence: number; install: boolean
  fieldOrder: string[]; nodeOrder: string[]
  fields: [string, unknown][]; nodes: [string, unknown][]
  /** Exact prepared JSON for the initial base; decoded only in the host worker. */
  installJson?: string
}
export type CodecReceipt = { owner: string; sequence: number; json: string }
/** One bounded codec owner, with immutable authored snapshots across awaits.
 * Only changed values cross IPC. Key order travels explicitly so the result
 * remains byte-identical to JSON.stringify, including numeric keys/deletions.
 * Persistence still receives the complete immutable JSON at its boundary. */
export class ResidentDocumentEncoder {
  private readonly owner = crypto.randomUUID()
  private sequence = 0
  private previous?: DesignDocument
  private json?: string
  private installJson?: string
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private send: (request: CodecDelta) => Promise<CodecReceipt>,
    prepared?: { document: DesignDocument; json: string }) {
    // The session supplies this only after its private adoption certificate and
    // version/session fences pass. Never infer encoded bytes from a document ID.
    if (prepared) {
      this.previous = prepared.document
      this.json = this.installJson = prepared.json
    }
  }
  encode(document: DesignDocument): Promise<string> {
    const work = this.tail.then(() => this.perform(document))
    this.tail = work.catch(() => {})
    return work
  }
  private async perform(document: DesignDocument): Promise<string> {
    if (document === this.previous && this.json !== undefined) return this.json
    const previous = this.previous?.id === document.id ? this.previous : undefined
    const installJson = previous ? this.installJson : undefined
    const changed = previous ? documentPatch(previous, document) : undefined
    const fieldOrder = Object.keys(document).filter(key => document[key as keyof DesignDocument] !== undefined)
    const nodeOrder = Object.keys(document.nodes)
    const request = (install: boolean): CodecDelta => ({
      owner: this.owner, base: install ? 0 : this.sequence, sequence: this.sequence + 1, install,
      ...(install && installJson !== undefined ? { installJson } : {}),
      fieldOrder, nodeOrder,
      fields: fieldOrder.filter(key => key !== 'nodes' && (install && installJson === undefined || Object.hasOwn(changed!.fields, key)))
        .map(key => [key, document[key as keyof DesignDocument]]),
      nodes: (install && installJson === undefined ? nodeOrder : Object.keys(changed!.nodes).filter(id => !!document.nodes[id]))
        .map(id => [id, document.nodes[id]]),
    })
    let receipt: CodecReceipt
    try { receipt = await this.send(request(!previous || installJson !== undefined)) }
    catch (error) {
      // A retired/restarted worker has no authority to apply a patch. Install
      // once; validation/size/transport failures remain visible to the caller.
      if (!previous || !String(error).includes('CODEC_BASE_MISSING')) throw error
      receipt = await this.send(request(true))
    }
    if (receipt.owner !== this.owner || receipt.sequence !== this.sequence + 1 || typeof receipt.json !== 'string')
      throw Error('Invalid document codec receipt')
    this.sequence = receipt.sequence; this.previous = document; this.json = receipt.json
    this.installJson = undefined
    return receipt.json
  }
}
