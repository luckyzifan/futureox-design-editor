const normalizedByte = Float32Array.from({ length: 256 }, (_, i) => i / 255)

export function unorm8ToFloat32(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const values = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) values[i] = normalizedByte[bytes[i]]
  return values
}

// Keep multiplication in byte space so UNORM normalization cannot perturb ties.
function roundEven(v: number) {
  const lo = Math.floor(v),
    fraction = v - lo
  return fraction < 0.5 ? lo : fraction > 0.5 ? lo + 1 : lo + (lo % 2)
}
export function solidRgba8(rgb: number[], opacity: number): number[] {
  const alpha = Math.fround(Math.max(0, Math.min(1, opacity)))
  return [
    ...rgb.map(
      (c) =>
        roundEven(Math.fround(roundEven(Math.fround(Math.max(0, Math.min(1, c)) * 255)) * alpha)) /
        255,
    ),
    roundEven(Math.fround(255 * alpha)) / 255,
  ]
}

/** Consume the Q12 minified pixel-preview output using the CPU preview's
 * integer half-up straight-alpha boundary. Ordinary display uses its own
 * measured Metal reciprocal conversion; it is intentionally unchanged. */
export function minifiedPreviewRgba8(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3]
    for (let c = 0; c < 3; c++)
      bytes[i + c] = alpha ? Math.min(255, Math.floor((bytes[i + c] * 510 + alpha) / (alpha * 2))) : 0
  }
  return bytes
}
