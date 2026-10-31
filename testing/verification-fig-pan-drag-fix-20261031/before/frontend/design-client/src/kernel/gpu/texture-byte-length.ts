/** Validate before GPU allocation or accounting. NaN passes ordinary range
 * comparisons and would otherwise poison the shared byte ledger. */
export function textureByteLength(width: number, height: number, bytesPerPixel: number) {
  if (![width, height, bytesPerPixel].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('无效的 GPU 纹理尺寸')
  const bytes = width * height * bytesPerPixel
  if (!Number.isSafeInteger(bytes)) throw new Error('无效的 GPU 纹理字节数')
  return bytes
}
