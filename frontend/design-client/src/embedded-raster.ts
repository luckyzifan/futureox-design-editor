/** Schemes the kernel raster codec admits. GIF is the first frame only.
 * TIFF is a single page. The original encoded bytes stay in the data URI. */
export const EMBEDDED_RASTER_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/webp;base64,',
  'data:image/gif;base64,',
  'data:image/tiff;base64,',
] as const

export const EMBEDDED_RASTER_PREFIX = /^data:image\/(?:png|jpeg|webp|gif|tiff);base64,/
export const EMBEDDED_RASTER_URI = /^data:image\/(?:png|jpeg|webp|gif|tiff);base64,[A-Za-z0-9+/=]+$/
