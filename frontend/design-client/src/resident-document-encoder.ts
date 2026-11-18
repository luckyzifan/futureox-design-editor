import { documentPatch } from './document-patch'
import type { DesignDocument } from './model'

export type CodecDelta = {
  owner: string; base: number; sequence: number; install: boolean
  fieldOrder: string[]; nodeOrder: string[]
  fields: [string, unknown][]; nodes: [string, unknown][]
  /** Exact prepared JSON for the initial base; decoded only in the host worker. */
  installJson?: string
}
export type CodecReceipt = { owner: string; sequence: number } & (
  { json: string; documentDeflate?: never } | { json?: never; documentDeflate: Uint8Array<ArrayBuffer> }
)
export type DocumentText = Readonly<{
  json: string
  chunks?: readonly string[]
  documentDeflate?: Uint8Array
}>

const chunkBytes = 256 * 1024
const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Preserve exact JSON equality without flattening a decoded document in one task. */
export async function sameDocumentText(a: DocumentText, b: DocumentText): Promise<boolean> {
  if (a === b) return true
  if (a.json.length !== b.json.length) return false
  if (!a.chunks && !b.chunks) return a.json === b.json
  const left = a.chunks ?? [a.json]
  const right = b.chunks ?? [b.json]
  let leftIndex = 0, rightIndex = 0, leftOffset = 0, rightOffset = 0
  let deadline = performance.now() + 4
  while (leftIndex < left.length && rightIndex < right.length) {
    const first = left[leftIndex], second = right[rightIndex]
    const length = Math.min(first.length - leftOffset, second.length - rightOffset, chunkBytes)
    if (first.slice(leftOffset, leftOffset + length) !== second.slice(rightOffset, rightOffset + length)) return false
    leftOffset += length
    rightOffset += length
    if (leftOffset === first.length) { leftIndex++; leftOffset = 0 }
    if (rightOffset === second.length) { rightIndex++; rightOffset = 0 }
    if (performance.now() >= deadline) {
      await nextTask()
      deadline = performance.now() + 4
    }
  }
  return leftIndex === left.length && rightIndex === right.length
}

/** One bounded codec owner, with immutable authored snapshots across awaits.
 * Authored deltas carry their key order so encoding stays byte-identical to
 * JSON.stringify. Full JSON stays paired with its compressed storage bytes. */
export class ResidentDocumentEncoder {
  private readonly owner = crypto.randomUUID()
  private sequence = 0
  private previous?: DesignDocument
  private text?: DocumentText
  private installJson?: string
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private send: (request: CodecDelta) => Promise<CodecReceipt>,
    prepared?: { document: DesignDocument; json: string }) {
    // The session supplies this only after its private adoption certificate and
    // version/session fences pass. Never infer encoded bytes from a document ID.
    if (prepared) {
      this.previous = prepared.document
      this.installJson = prepared.json
      this.text = { json: prepared.json }
    }
  }
  async encode(document: DesignDocument): Promise<string> {
    return (await this.encodeText(document)).json
  }
  encodeText(document: DesignDocument): Promise<DocumentText> {
    const work = this.tail.then(() => this.perform(document))
    this.tail = work.catch(() => {})
    return work
  }
  private async perform(document: DesignDocument): Promise<DocumentText> {
    if (document === this.previous && this.text) return this.text
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
    if (receipt.owner !== this.owner || receipt.sequence !== this.sequence + 1)
      throw Error('Invalid document codec receipt')
    let json = receipt.json
    let chunks: string[] | undefined
    const documentDeflate = receipt.documentDeflate
    if (typeof json === 'string') {
      if (documentDeflate !== undefined) throw Error('Invalid document codec receipt')
    } else {
      if (!(documentDeflate instanceof Uint8Array) || !documentDeflate.byteLength)
        throw Error('Invalid document codec receipt')
      let offset = 0
      const stream = new ReadableStream<BufferSource>({
        async pull(controller) {
          // Give input and paint a task boundary between decompression chunks.
          if (offset) await nextTask()
          const end = Math.min(offset + chunkBytes, documentDeflate.length)
          controller.enqueue(documentDeflate.subarray(offset, end))
          offset = end
          if (offset === documentDeflate.length) controller.close()
        },
      })
      const reader = stream.pipeThrough(new DecompressionStream('deflate'))
        .pipeThrough(new TextDecoderStream('utf-8', { fatal: true, ignoreBOM: true })).getReader()
      json = ''
      chunks = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          chunks.push(value)
          json += value
        }
      } finally {
        reader.releaseLock()
      }
      if (!json) throw Error('Invalid document codec receipt')
    }
    this.sequence = receipt.sequence
    this.previous = document
    this.text = { json, chunks, documentDeflate }
    this.installJson = undefined
    return this.text
  }
}
