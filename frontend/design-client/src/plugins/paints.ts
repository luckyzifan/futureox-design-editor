import { paint, type Paint } from '../model'
import { PluginApiError } from './errors'
import { bytesFromDataUrl, dataUrlForImage, imageContentId, imageMime, imageSize } from './rich-host/images'

/** Image bytes kept for this plugin turn. The hash is the SHA-1 of those bytes. */
export type PluginImageRecord = { mime: string; bytes: Uint8Array; base64: string; dataUrl: string }

const gradientKinds = {
  GRADIENT_LINEAR: 'linear',
  GRADIENT_RADIAL: 'radial',
  GRADIENT_ANGULAR: 'angular',
  GRADIENT_DIAMOND: 'diamond',
} as const

const kindToGradient: Record<string, string> = {
  linear: 'GRADIENT_LINEAR',
  radial: 'GRADIENT_RADIAL',
  angular: 'GRADIENT_ANGULAR',
  diamond: 'GRADIENT_DIAMOND',
}

const supportedKinds = new Set(['solid', 'linear', 'radial', 'angular', 'diamond', 'image'])

function fail(api: string, code: 'unsupported' | 'invalid'): never {
  throw new PluginApiError(api, code)
}

function finite(value: unknown, min: number, max: number, api: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(api, 'invalid')
  return value
}

function channel(value: number | undefined, api: string) {
  return Math.round(finite(value, 0, 1, api) * 255).toString(16).padStart(2, '0')
}

export function rgbToHex(color: { r?: number; g?: number; b?: number } | undefined, api: string) {
  return `#${channel(color?.r, api)}${channel(color?.g, api)}${channel(color?.b, api)}`
}

export function hexToRgb(value: string, api: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) fail(api, 'unsupported')
  const parsed = Number.parseInt(value.slice(1), 16)
  return { r: ((parsed >> 16) & 255) / 255, g: ((parsed >> 8) & 255) / 255, b: (parsed & 255) / 255 }
}

function angleOf(transform: unknown): number | undefined {
  if (!Array.isArray(transform) || !Array.isArray(transform[0]) || !Array.isArray(transform[1])) return undefined
  const a = Number((transform[0] as unknown[])[0])
  const b = Number((transform[1] as unknown[])[0])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  const degrees = Math.atan2(b, a) * 180 / Math.PI
  return Number.isFinite(degrees) ? degrees : undefined
}

function matrixFromTransform(transform: unknown): Paint['transform'] | undefined {
  if (!Array.isArray(transform) || transform.length !== 2) return undefined
  const row0 = transform[0]
  const row1 = transform[1]
  if (!Array.isArray(row0) || !Array.isArray(row1) || row0.length < 3 || row1.length < 3) return undefined
  const values = [row0[0], row1[0], row0[1], row1[1], row0[2], row1[2]]
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7)) return undefined
  return values as Paint['transform']
}

function gradientTransform(item: Paint) {
  if (item.transform) {
    const [a, b, c, d, tx, ty] = item.transform
    return [[a, c, tx], [b, d, ty]]
  }
  const radians = (item.angle || 0) * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [[cos, -sin, 0], [sin, cos, 0]]
}

function remember(images: Map<string, PluginImageRecord>, bytes: Uint8Array, mime: string) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  const record: PluginImageRecord = { mime, bytes, base64, dataUrl: dataUrlForImage(mime, base64) }
  images.set(imageContentId(bytes), record)
  return record
}

export function registerImageBytes(images: Map<string, PluginImageRecord>, value: unknown) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 256 * 1024) fail('figma.createImage', 'invalid')
  const mime = imageMime(value)
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) fail('figma.createImage', 'unsupported')
  const record = remember(images, value, mime)
  return { hash: imageContentId(value), record }
}

export function imageFromHash(images: Map<string, PluginImageRecord>, hash: string) {
  const found = images.get(hash)
  if (!found) return null
  return { hash, record: found, size: imageSize(found.bytes, found.mime) }
}

function indexDocumentImage(images: Map<string, PluginImageRecord>, value: string | undefined) {
  if (!value) return null
  const decoded = bytesFromDataUrl(value)
  if (!decoded) return null
  const mime = imageMime(decoded.bytes)
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return null
  remember(images, decoded.bytes, mime)
  return imageContentId(decoded.bytes)
}

export type PluginPaint = {
  type: string
  color?: { r: number; g: number; b: number }
  opacity: number
  visible: boolean
  gradientStops?: { position: number; color: { r: number; g: number; b: number; a: number } }[]
  gradientTransform?: number[][]
  imageHash?: string
  scaleMode?: 'FILL' | 'FIT' | 'CROP'
}

/** Read every paint or throw. An unsupported paint is not replaced with a solid. */
export function readPluginPaints(paints: Paint[], images: Map<string, PluginImageRecord>, api: string): PluginPaint[] {
  return paints.map(item => {
    if (!supportedKinds.has(item.kind)) fail(`${api} ${item.kind} paint`, 'unsupported')
    if (item.kind === 'solid') return { type: 'SOLID', color: hexToRgb(item.color, api), opacity: item.opacity, visible: item.visible }
    if (item.kind === 'image') {
      const hash = indexDocumentImage(images, item.image)
      if (!hash) fail(`${api} image paint`, 'unsupported')
      const scale = item.fit === 'contain' ? 'FIT' : item.fit === 'stretch' ? 'CROP' : 'FILL'
      return { type: 'IMAGE', imageHash: hash, scaleMode: scale, opacity: item.opacity, visible: item.visible }
    }
    const type = kindToGradient[item.kind]
    if (!type) fail(`${api} ${item.kind} paint`, 'unsupported')
    return {
      type,
      opacity: item.opacity,
      visible: item.visible,
      gradientStops: item.stops.map(stop => ({ position: stop.offset, color: { ...hexToRgb(stop.color, api), a: 1 } })),
      gradientTransform: gradientTransform(item),
    }
  })
}

export function writePluginPaints(value: unknown, images: Map<string, PluginImageRecord>, api: string): Paint[] {
  if (!Array.isArray(value) || value.length > 16) fail(api, 'invalid')
  return value.map(entry => writeOne(entry, images, api))
}

function writeOne(entry: unknown, images: Map<string, PluginImageRecord>, api: string): Paint {
  if (!entry || typeof entry !== 'object') fail(api, 'invalid')
  const record = entry as {
    type?: string
    color?: { r?: number; g?: number; b?: number }
    opacity?: number
    visible?: boolean
    gradientStops?: unknown
    gradientTransform?: unknown
    imageHash?: unknown
    scaleMode?: unknown
  }
  const opacity = record.opacity === undefined ? 1 : finite(record.opacity, 0, 1, `${api}.opacity`)
  const visible = record.visible !== false
  if (record.type === 'SOLID') {
    const color = rgbToHex(record.color, api)
    const created = paint(color)
    created.opacity = opacity
    created.visible = visible
    created.stops = [{ offset: 0, color }, { offset: 1, color }]
    return created
  }
  const gradient = record.type ? gradientKinds[record.type as keyof typeof gradientKinds] : undefined
  if (gradient) {
    if (!Array.isArray(record.gradientStops) || record.gradientStops.length < 2 || record.gradientStops.length > 16) fail(`${api} ${record.type}`, 'invalid')
    const stops = record.gradientStops.map(stop => {
      if (!stop || typeof stop !== 'object') fail(`${api} gradient stop`, 'invalid')
      const item = stop as { position?: number; color?: { r?: number; g?: number; b?: number } }
      return { offset: finite(item.position, 0, 1, `${api} gradient stop`), color: rgbToHex(item.color, api) }
    })
    const created = paint(stops[0].color, gradient)
    created.opacity = opacity
    created.visible = visible
    created.stops = stops
    const angle = angleOf(record.gradientTransform)
    created.angle = angle ?? 180
    const transform = matrixFromTransform(record.gradientTransform)
    if (transform) created.transform = transform
    return created
  }
  if (record.type === 'IMAGE') {
    if (typeof record.imageHash !== 'string' || !images.has(record.imageHash)) fail(`${api} image hash`, 'invalid')
    const stored = images.get(record.imageHash)!
    const created = paint('#ffffff', 'image')
    const scale = record.scaleMode === undefined ? 'FILL' : String(record.scaleMode)
    if (!['FILL', 'FIT', 'CROP'].includes(scale)) fail(`${api} scaleMode`, 'unsupported')
    created.fit = scale === 'FIT' ? 'contain' : scale === 'CROP' ? 'stretch' : 'cover'
    created.image = stored.dataUrl
    created.opacity = opacity
    created.visible = visible
    return created
  }
  fail(`${api} ${record.type ?? 'unknown'} paint`, 'unsupported')
}

export function pluginSvgMarkup(node: { kind: string; width: number; height: number; radii: [number, number, number, number]; text: string; fontSize: number; fills: Paint[] }) {
  const width = Math.max(0.01, node.width)
  const height = Math.max(0.01, node.height)
  const visible = [...node.fills].reverse().find(item => item.visible)
  const fill = visible?.kind === 'solid' && /^#[0-9a-f]{6}$/i.test(visible.color) ? visible.color : 'none'
  const escape = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
  const body = node.kind === 'ellipse'
    ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}"/>`
    : node.kind === 'text'
      ? `<text x="0" y="${Math.max(1, node.fontSize)}" font-size="${Math.max(1, node.fontSize)}">${escape(node.text)}</text>`
      : `<rect width="${width}" height="${height}" rx="${node.radii[0]}" fill="${fill}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}
