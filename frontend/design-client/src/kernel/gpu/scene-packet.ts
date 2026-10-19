import type { GpuScene } from './types'

/** FGPK v1 keeps large geometry arrays in their shader-native f32 format.
 * Views own the wasm-bindgen returned copy, never a growable WASM heap view. */
export function decodeScenePacket(input: Uint8Array): GpuScene {
  const bytes = input.byteOffset % 4 || !(input.buffer instanceof ArrayBuffer) ? input.slice() : input as Uint8Array<ArrayBuffer>
  if (bytes.byteLength < 24) throw new Error('Truncated GPU scene packet')
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.getUint32(0, true) !== 0x4b504746 || header.getUint32(4, true) !== 1 || header.getUint32(20, true) !== 0)
    throw new Error('Unsupported GPU scene packet')
  const metadataLength = header.getUint32(8, true), vertices = header.getUint32(12, true), curves = header.getUint32(16, true)
  const offset = Math.ceil((24 + metadataLength) / 4) * 4
  if (offset + (vertices + curves) * 4 !== bytes.byteLength)
    throw new Error('Invalid GPU scene packet length')
  const scene = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(24, 24 + metadataLength))) as GpuScene
  if (scene.version !== 7 && scene.version !== 8) throw new Error('Unsupported GPU scene version')
  scene.vertices = new Float32Array(bytes.buffer, bytes.byteOffset + offset, vertices)
  scene.curves = new Float32Array(bytes.buffer, bytes.byteOffset + offset + vertices * 4, curves)
  return scene
}
