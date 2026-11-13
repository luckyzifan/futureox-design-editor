export {
  EMBEDDED_RASTER_PREFIXES,
  GIF_FIRST_FRAME_RULE,
  RASTER_FILE_ACCEPT,
  RASTER_IMPORT_EXTENSION,
  RASTER_MIME_ACCEPT,
} from './embedded-raster'

const STILL_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const TRUSTED_MIME = new Set(['image/gif', 'image/tiff'])

/** Preserve the original encoded asset. Import admission must never silently
 * resize, canvas-reencode, remove color metadata or introduce a lossy format.
 * PNG, JPEG and WebP dimensions use the browser decoder. GIF and TIFF
 * dimensions use the Rust/WASM decoder: an animated GIF contributes only its
 * first frame, and a TIFF must be one classic page. The original data URI is
 * retained byte-for-byte. Resource limits are explicit errors, not quality modes. */
export async function imageData(
  file: File,
  maxPixels = 16_777_216,
): Promise<{ data: string; width: number; height: number; resized?: boolean; animation?: 'first-frame' }> {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 16_777_216)
    throw new Error('无效的图片像素预算')
  const mime = declaredMime(file)
  if (!mime || file.size > 8 * 1024 * 1024)
    throw new Error('请使用不超过 8 MB 的 PNG、JPEG、WebP、GIF 或 TIFF 图片')
  const raw = await readDataUrl(file)
  if (raw.length > 12 * 1024 * 1024) throw new Error('图片数据超过 12 MB 上限；未修改原图')
  const data = canonicalDataUrl(raw, mime)
  if (data.length > 12 * 1024 * 1024) throw new Error('图片数据超过 12 MB 上限；未修改原图')
  const size = TRUSTED_MIME.has(mime) ? await trustedRasterSize(data) : await browserSize(data)
  const { width, height } = size
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('图片尺寸无效')
  if (width * height > maxPixels)
    throw new Error('图片超过像素预算；为保持原图精度，未自动缩小或重新编码')
  return mime === 'image/gif'
    ? { data, width, height, animation: 'first-frame' }
    : { data, width, height }
}

function declaredMime(file: File): string | null {
  if (file.type === 'image/x-tiff') return 'image/tiff'
  if (STILL_MIME.has(file.type) || TRUSTED_MIME.has(file.type)) return file.type
  if (file.type && file.type !== 'application/octet-stream') return null
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase()
  if (extension === 'gif') return 'image/gif'
  if (extension === 'tif' || extension === 'tiff') return 'image/tiff'
  return null
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('图片读取结果无效'))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.readAsDataURL(file)
  })
}

function canonicalDataUrl(data: string, mime: string): string {
  const comma = data.indexOf(',')
  const header = comma >= 0 ? data.slice(0, comma) : ''
  if (comma < 0 || !header.includes('base64')) throw new Error('图片读取结果无效')
  const prefix = `data:${mime};base64,`
  if (data.startsWith(prefix)) return data
  if (mime === 'image/gif' || mime === 'image/tiff') return prefix + data.slice(comma + 1)
  return data
}

async function browserSize(data: string): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = data
  await image.decode()
  return { width: image.naturalWidth, height: image.naturalHeight }
}

async function trustedRasterSize(data: string): Promise<{ width: number; height: number }> {
  const { VectorEngine } = await import('./generated/design-kernel/design_kernel.js')
  const engine = new VectorEngine()
  try {
    const info = JSON.parse(engine.image_info(data)) as unknown
    if (!Array.isArray(info) || info.length < 2) throw new Error('图片尺寸无效')
    const width = info[0], height = info[1]
    if (typeof width !== 'number' || typeof height !== 'number') throw new Error('图片尺寸无效')
    return { width, height }
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    if (message.includes('Decoded image budget exceeded') || message.includes('without loss'))
      throw new Error('图片超过像素预算；为保持原图精度，未自动缩小或重新编码')
    throw new Error(message || '图片解码失败')
  } finally {
    engine.free()
  }
}
