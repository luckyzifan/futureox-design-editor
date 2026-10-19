import type { GpuNode, GpuScene } from './types'
type Spans = { length: number; spans: [number, number][]; copies: [number, number, number][] }
type Update = { base: number; sequence: number; fields: GpuScene | null; nodes: Record<string, GpuNode>; removed: string[]; vertices: Spans; curves: Spans }
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0

/** Atomic decoder for one CPU-engine session. Invalid/out-of-order updates
 * leave the previous scene untouched. Geometry compares and copies raw words. */
export class SceneDeltaDecoder {
  private sequence = 0
  private scene?: GpuScene
  clear() { this.scene = undefined; this.sequence = 0 }
  decode(input: Uint8Array): GpuScene {
    if (input.byteLength < 24) throw Error('Truncated scene update')
    const header = new DataView(input.buffer, input.byteOffset, input.byteLength)
    if (header.getUint32(0, true) !== 0x44504746 || header.getUint32(4, true) !== 1 || header.getUint32(20, true))
      throw Error('Unsupported scene update')
    const jsonLength = header.getUint32(8, true), nv = header.getUint32(12, true), nc = header.getUint32(16, true)
    const start = Math.ceil((24 + jsonLength) / 4) * 4
    if (start + (nv + nc) * 4 !== input.byteLength) throw Error('Invalid scene update length')
    const update = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(24, 24 + jsonLength))) as Update
    if (!integer(update.sequence) || update.sequence <= this.sequence || !integer(update.base) ||
      (update.base !== 0 && (update.base !== this.sequence || !this.scene))) throw Error('Stale scene update')
    const previous = update.base ? this.scene : undefined, fields = update.fields || previous
    if (!fields || (fields.version !== 7 && fields.version !== 8) || !update.nodes || typeof update.nodes !== 'object' ||
      Array.isArray(update.nodes) || !Array.isArray(update.removed) || !update.removed.every(id => typeof id === 'string'))
      throw Error('Invalid scene update metadata')
    const nodes = { ...(previous?.nodes || {}), ...update.nodes }
    for (const id of update.removed) delete nodes[id]
    const apply = (old: number[] | Float32Array<ArrayBuffer> | undefined, shape: Spans, offset: number, count: number): Float32Array<ArrayBuffer> => {
      if (!shape || !integer(shape.length) || shape.length > 16_777_216 || !Array.isArray(shape.spans)) throw Error('Invalid geometry update')
      let end = 0, used = 0, initialized = Math.min(old?.length || 0, shape.length)
      for (const span of shape.spans) {
        if (!Array.isArray(span) || span.length !== 2 || !span.every(integer) || span[1] === 0 || span[0] < end || span[0] + span[1] > shape.length)
          throw Error('Invalid geometry span')
        if (span[0] > initialized) throw Error('Uninitialized geometry span')
        end = span[0] + span[1]; used += span[1]; initialized = Math.max(initialized, end)
      }
      if (!Array.isArray(shape.copies)) throw Error('Invalid geometry copies')
      for (const copy of shape.copies) {
        if (!Array.isArray(copy) || copy.length !== 3 || !copy.every(integer) || !copy[2] || !old ||
          copy[0] < end || copy[0] > initialized || copy[0]+copy[2] > shape.length || copy[1]+copy[2] > old.length)
          throw Error('Invalid geometry copy')
        end=copy[0]+copy[2]; initialized=Math.max(initialized,end)
      }
      if (initialized !== shape.length) throw Error('Uninitialized geometry tail')
      if (used !== count) throw Error('Invalid geometry payload')
      if (!shape.spans.length && !shape.copies.length && old instanceof Float32Array && old.length === shape.length) return old
      const result = new Float32Array(shape.length), words = new Uint32Array(result.buffer)
      if (old) {
        const source = old instanceof Float32Array ? old : new Float32Array(old)
        words.set(new Uint32Array(source.buffer, source.byteOffset, Math.min(source.length, result.length)))
      }
      if (old && shape.copies.length) {
        const source=old instanceof Float32Array ? old : new Float32Array(old)
        const sourceWords=new Uint32Array(source.buffer,source.byteOffset,source.length)
        for(const [to,from,length] of shape.copies)words.set(sourceWords.subarray(from,from+length),to)
      }
      let cursor = offset
      for (const [at, length] of shape.spans) {
        if ((input.byteOffset + cursor) % 4 === 0) {
          words.set(new Uint32Array(input.buffer, input.byteOffset + cursor, length), at); cursor += length * 4
        } else for (let i = 0; i < length; i++, cursor += 4) words[at + i] = header.getUint32(cursor, true)
      }
      return result
    }
    const vertices = apply(previous?.vertices, update.vertices, start, nv)
    const curves = apply(previous?.curves, update.curves, start + nv * 4, nc)
    const scene = { ...fields, nodes, vertices, curves }
    this.scene = scene; this.sequence = update.sequence
    // The renderer may attach per-request policy to its returned root object.
    return { ...scene }
  }
}
