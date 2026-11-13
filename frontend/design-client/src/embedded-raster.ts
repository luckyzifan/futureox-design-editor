/** Embedded raster paints shared by document admission, GPU upload and import.
 * GIF is imported as a still image: only the first frame is decoded.
 * TIFF is one classic page. The data URI keeps the original file bytes. */
export const EMBEDDED_RASTER_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/webp;base64,',
  'data:image/gif;base64,',
  'data:image/tiff;base64,',
] as const

export const EMBEDDED_RASTER_URI = /^data:image\/(png|jpeg|webp|gif|tiff);base64,[A-Za-z0-9+/=]+$/
export const EMBEDDED_RASTER_URI_PREFIX = /^data:image\/(png|jpeg|webp|gif|tiff);base64,/

export const RASTER_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/tiff'] as const
export const RASTER_MIME_ACCEPT = RASTER_MIME_TYPES.join(',')
export const RASTER_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff'
export const RASTER_IMPORT_EXTENSION = /\.(png|jpe?g|webp|gif|tiff?)$/i

export const GIF_FIRST_FRAME_RULE =
  '动画 GIF 只导入并绘制首帧，后续帧不参与画布；原始文件字节保持不变，不会降采样或改为有损格式。'

export function isEmbeddedRasterUri(uri: string): boolean {
  return EMBEDDED_RASTER_URI.test(uri)
}
