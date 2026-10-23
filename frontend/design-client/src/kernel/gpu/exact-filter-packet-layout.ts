/** Physical storage only. Logical packets and their integer words never change. */
export type ExactFilterPacketLayout = Readonly<{
  width: number; height: number; logicalTexels: number; physicalTexels: number; bytes: number
}>

export function exactFilterPacketLayout(logicalTexels: number, actualLimit: number): ExactFilterPacketLayout | undefined {
  if (!Number.isSafeInteger(logicalTexels) || logicalTexels < 1 || logicalTexels > 16384 ||
      !Number.isSafeInteger(actualLimit) || actualLimit < 1) return
  const height = Math.ceil(logicalTexels / actualLimit)
  const width = Math.ceil(logicalTexels / height)
  const physicalTexels = width * height
  if (width > actualLimit || height > actualLimit || !Number.isSafeInteger(physicalTexels) ||
      physicalTexels < logicalTexels) return
  return { width, height, logicalTexels, physicalTexels, bytes: physicalTexels * 16 }
}

/** Framing check, not a mathematical, finite-source or prefix certificate. */
export function exactFilterPacketTexels(bytes: Uint8Array): number | undefined {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
      bytes.byteLength < 16 || bytes.byteLength % 4 !== 0 || bytes.byteLength > 65536) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = view.getUint32(0, true), second = view.getUint32(4, true)
  const third = view.getUint32(8, true), fourth = view.getUint32(12, true)
  const texels = bytes.byteLength / 4
  if (first === 0x38345143) {
    if (second < 1 || second > 2048 || third !== 48 || (fourth !== 0 && fourth !== 64) ||
        texels !== 4 + 2 * (second + 1)) return
  } else if (first < 1 || first > 44 || second < first || second > 44 || third < 1 || third > 2048 ||
      fourth !== 0 || texels !== 4 + first * (third + 2)) return
  return texels
}
