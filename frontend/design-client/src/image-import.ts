import { EMBEDDED_RASTER_PREFIXES } from './embedded-raster'

/** Preserve the original encoded asset. Import admission must never silently
 * resize, canvas-reencode, remove color metadata, or introduce a lossy
 * transcode. GIF animation imports the first frame only; later frames are not
 * composited and the original GIF bytes stay in the data URI. TIFF import is
 * one page. PNG, JPEG, and WebP still use the browser only to read dimensions.
 * GIF and TIFF dimensions come from the kernel codec admission path. Resource
 * limits are explicit errors, not quality modes. */
const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/tiff'] as const
type RasterMime = (typeof RASTER_TYPES)[number]

export const GIF_FIRST_FRAME_NOTICE = 'GIF 只导入第一帧，后续动画帧不会进入画布'
export const RASTER_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff'
export const RASTER_MIME_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/tiff'
export function isImportedRasterFile(name: string) {
  return /\.(png|jpe?g|webp|gif|tiff?)$/i.test(name)
}

function canonicalRasterMime(type: string): RasterMime | null {
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/gif' || type === 'image/tiff')
    return type
  if (type === 'image/tif' || type === 'image/x-tiff') return 'image/tiff'
  return null
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('图片读取结果无效'))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.onabort = () => reject(new Error('图片读取已取消'))
    reader.readAsDataURL(file)
  })
}

function codecFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Decoded image budget exceeded') || message.includes('automatic downsampling is disabled'))
    return new Error('图片超过像素预算；为保持原图精度，未自动缩小或重新编码')
  if (message.includes('Multi-page TIFF'))
    return new Error('多页 TIFF 不能导入；只接受单页，未自动改写原图')
  if (message === '图片尺寸无效' || message.startsWith('图片超过像素预算') || message.startsWith('多页 TIFF'))
    return error instanceof Error ? error : new Error(message)
  return new Error(`图片解码失败：${message}`)
}

/** Kernel codec admission. This does not transcode the stored bytes. */
async function trustedRasterSize(data: string) {
  if (!EMBEDDED_RASTER_PREFIXES.some(prefix => data.startsWith(prefix)))
    throw new Error('Unsupported image URI')
  const [{ VectorEngine }, { initializeKernelModule }] = await Promise.all([
    import('./generated/design-kernel/design_kernel'),
    import('./kernel/module'),
  ])
  await initializeKernelModule()
  const engine = new VectorEngine()
  try {
    const parsed = JSON.parse(engine.image_info(data)) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('图片尺寸无效')
    const [width, height] = parsed
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error('图片尺寸无效')
    return { width, height }
  } catch (error) {
    throw codecFailure(error)
  } finally {
    engine.free()
  }
}

async function browserRasterSize(data: string) {
  const image = new Image()
  image.src = data
  await image.decode()
  return { width: image.naturalWidth, height: image.naturalHeight }
}

export async function imageData(
  file: File,
  maxPixels = 16_777_216,
): Promise<{ data: string; width: number; height: number; resized?: boolean }> {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 16_777_216)
    throw new Error('无效的图片像素预算')
  const mime = canonicalRasterMime(file.type)
  if (!mime || file.size > 8 * 1024 * 1024)
    throw new Error('请使用不超过 8 MB 的 PNG、JPEG、WebP、GIF 或 TIFF 图片')
  let data = await readDataUrl(file)
  // FileReader copies file.type into the data URL. Only the TIFF aliases need
  // a canonical prefix; the encoded payload is not rewritten.
  const comma = data.indexOf(',')
  if ((file.type === 'image/tif' || file.type === 'image/x-tiff') && comma >= 0)
    data = `data:image/tiff;base64,${data.slice(comma + 1)}`
  if (data.length > 12 * 1024 * 1024) throw new Error('图片数据超过 12 MB 上限；未修改原图')
  const size = mime === 'image/gif' || mime === 'image/tiff'
    ? await trustedRasterSize(data)
    : await browserRasterSize(data)
  const { width, height } = size
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('图片尺寸无效')
  if (width * height > maxPixels)
    throw new Error('图片超过像素预算；为保持原图精度，未自动缩小或重新编码')
  return { data, width, height }
}
