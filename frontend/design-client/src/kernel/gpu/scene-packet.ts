import type { GpuScene } from './types'

/** FGPK v1/v2 keep large geometry arrays in their shader-native f32 format.
 * v2 also carries complete, exact image strings outside JSON parsing.
 * Views own the wasm-bindgen returned copy, never a growable WASM heap view. */
export function decodeScenePacket(input: Uint8Array): GpuScene {
  const bytes = input.byteOffset % 4 || !(input.buffer instanceof ArrayBuffer) ? input.slice() : input as Uint8Array<ArrayBuffer>
  if (bytes.byteLength < 24) throw new Error('Truncated GPU scene packet')
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = header.getUint32(4, true), imageBytes = header.getUint32(20, true)
  if (header.getUint32(0, true) !== 0x4b504746 || (version !== 1 && version !== 2) || version === 1 && imageBytes !== 0)
    throw new Error('Unsupported GPU scene packet')
  const metadataLength = header.getUint32(8, true), vertices = header.getUint32(12, true), curves = header.getUint32(16, true)
  const offset = Math.ceil((24 + metadataLength) / 4) * 4
  const imageOffset = offset + (vertices + curves) * 4
  if (imageOffset + imageBytes !== bytes.byteLength)
    throw new Error('Invalid GPU scene packet length')
  const scene = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(24, 24 + metadataLength))) as GpuScene
  if (scene.version !== 7 && scene.version !== 8) throw new Error('Unsupported GPU scene version')
  if (version === 2) {
    const metadata = scene as GpuScene & { packetImageLengths?: unknown }
    const lengths = metadata.packetImageLengths
    if (!Array.isArray(lengths) || !lengths.length) throw new Error('Unsupported GPU image table')
    const images: string[] = [], decoder = new TextDecoder('utf-8', { fatal: true })
    let cursor = imageOffset
    for (const length of lengths) {
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.byteLength - cursor)
        throw new Error('Invalid GPU image length')
      images.push(decoder.decode(bytes.subarray(cursor, cursor + length))); cursor += length
    }
    if (cursor !== bytes.byteLength) throw new Error('Invalid GPU image table length')
    const restore = (paint: { image?: string }) => {
      if (paint.image == null) return
      const value = paint.image
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= images.length)
        throw new Error('Invalid GPU image reference')
      paint.image = images[Number(value)]
    }
    for (const node of Object.values(scene.nodes)) {
      for (const paint of node.fills) restore(paint)
      for (const stroke of node.strokes) restore(stroke.paint)
      if (node.textureReplay) restore(node.textureReplay.paint)
    }
    delete metadata.packetImageLengths
  }
  scene.vertices = new Float32Array(bytes.buffer, bytes.byteOffset + offset, vertices)
  scene.curves = new Float32Array(bytes.buffer, bytes.byteOffset + offset + vertices * 4, curves)
  return scene
}
