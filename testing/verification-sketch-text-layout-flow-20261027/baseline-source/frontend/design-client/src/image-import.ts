/** Preserve the original encoded asset. Import admission must never silently
 * resize, canvas-reencode, remove color metadata or introduce lossy WebP.
 * The decoder is used only to validate dimensions; the original data URI is
 * retained byte-for-byte. Resource limits are explicit errors, not quality modes. */
export async function imageData(
  file: File,
  maxPixels = 16_777_216,
): Promise<{ data: string; width: number; height: number; resized?: boolean }> {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 16_777_216)
    throw new Error('无效的图片像素预算')
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024)
    throw new Error('请使用不超过 8 MB 的 PNG、JPEG 或 WebP 图片')
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('图片读取结果无效'))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.readAsDataURL(file)
  })
  if (data.length > 12 * 1024 * 1024) throw new Error('图片数据超过 12 MB 上限；未修改原图')
  const image = new Image()
  image.src = data
  await image.decode()
  const width = image.naturalWidth, height = image.naturalHeight
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('图片尺寸无效')
  if (width * height > maxPixels)
    throw new Error('图片超过像素预算；为保持原图精度，未自动缩小或重新编码')
  return { data, width, height }
}
