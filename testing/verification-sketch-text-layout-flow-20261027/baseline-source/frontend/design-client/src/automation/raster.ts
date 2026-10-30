import type { DesignDocument } from '../model'
import type { ExportTarget } from '../export-metadata'
import { sliceExportTarget } from '../export-metadata'
import { scene } from '../geometry'
import { kernelLayout, initializePicking, kernelExportPlan } from '../kernel/picking'
import { AutomationError, type AutomationMethod } from './types'

export const RASTER_LIMITS = Object.freeze({ pixels: 64_000_000, maxSide: 16384, scales: 16, nodeIds: 256, bytes: 64 * 1024 * 1024, artifacts: 32, chunkBytes: 64 * 1024, lifetimeMs: 5 * 60_000 })
const idSchema = { type: 'string', minLength: 1, maxLength: 512 }
export const rasterMethods: AutomationMethod[] = [
  { name: 'raster.export', mutates: false, description: 'Export exact product CPU PNG/JPEG/WebP pixels at 1x/2x/3x or custom scales. Page padding defaults to zero; selection and authored slice targets share the UI exporter. Returns immutable session-local artifact handles; use raster.read in bounded chunks, then raster.release. 64 MP total; never silently reduces scale. PNG preserves transparency; CPU export is not GPU screenshot equivalence.', inputSchema: { type: 'object', additionalProperties: false, properties: {
    pageId: idSchema, nodeIds: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: idSchema }, sliceId: idSchema,
    padding: { type: 'number', minimum: 0, maximum: 1000000 }, format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    scales: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'number', minimum: 0.001, maximum: 128 } },
  } } },
  { name: 'raster.read', mutates: false, description: 'Read at most 64 KiB of an immutable raster artifact as base64. Offset is in bytes; repeat until nextOffset equals totalBytes. Handles belong to the authorized session and expire after five minutes.', inputSchema: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: idSchema, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: RASTER_LIMITS.chunkBytes } } } },
  { name: 'raster.release', mutates: false, description: 'Release one session-local raster artifact after saving its bytes.', inputSchema: { type: 'object', additionalProperties: false, required: ['artifactId'], properties: { artifactId: idSchema } } },
]
export function rasterParams(input: Record<string, unknown>) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['pageId', 'nodeIds', 'sliceId', 'padding', 'format', 'scales'].includes(k))) throw new AutomationError('invalid_params', 'Unknown raster export option')
  for (const key of ['pageId', 'sliceId']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !(input[key] as string).length || (input[key] as string).length > 512)) throw new AutomationError('invalid_params', `Invalid ${key}`)
  const nodeIds = input.nodeIds as string[] | undefined
  if (nodeIds !== undefined && (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > RASTER_LIMITS.nodeIds || nodeIds.some(id => typeof id !== 'string' || !id.length || id.length > 512) || new Set(nodeIds).size !== nodeIds.length)) throw new AutomationError('invalid_params', 'Invalid raster selection')
  if (nodeIds && input.sliceId !== undefined || input.padding !== undefined && (nodeIds || input.sliceId !== undefined)) throw new AutomationError('invalid_params', 'Choose page, nodeIds or sliceId; padding is page-only')
  if (input.padding !== undefined && (typeof input.padding !== 'number' || !Number.isFinite(input.padding) || input.padding < 0 || input.padding > 1e6)) throw new AutomationError('invalid_params', 'Invalid page padding')
  const format = input.format ?? 'png', scales = input.scales ?? [1]
  if (!['png', 'jpeg', 'webp'].includes(format as string)) throw new AutomationError('invalid_params', 'Unsupported raster format')
  if (!Array.isArray(scales) || !scales.length || scales.length > RASTER_LIMITS.scales || new Set(scales).size !== scales.length || scales.some(s => typeof s !== 'number' || !Number.isFinite(s) || s < 0.001 || s > 128)) throw new AutomationError('invalid_params', 'Provide 1–16 distinct scales between 0.001 and 128')
  return { pageId: input.pageId as string | undefined, nodeIds, sliceId: input.sliceId as string | undefined, padding: input.padding as number | undefined, format: format as 'png' | 'jpeg' | 'webp', scales: scales as number[] }
}
export async function captureRaster(document: DesignDocument, input: Record<string, unknown>, signal: AbortSignal) {
  const options = rasterParams(input)
  signal.throwIfAborted()
  await initializePicking()
  signal.throwIfAborted()
  const doc = kernelLayout(document), pageId = options.pageId ?? doc.pages[0]?.id
  if (!doc.pages.some(p => p.id === pageId)) throw new AutomationError('invalid_params', 'Raster page does not exist')
  if (options.sliceId && !scene(doc, pageId).some(e => e.id === options.sliceId)) throw new AutomationError('invalid_params', 'Slice is not on the selected page')
  const target: ExportTarget = options.sliceId ? sliceExportTarget(doc, options.sliceId) : options.nodeIds ? { kind: 'selection', nodeIds: options.nodeIds } : { kind: 'page', padding: options.padding ?? 0 }
  const { targetBounds, exportRasterBatch } = await import('../export')
  signal.throwIfAborted()
  const bounds = targetBounds(doc, pageId, target)
  const plans = options.scales.map(scale => {
    const width = Math.ceil(bounds.width * scale), height = Math.ceil(bounds.height * scale)
    if (![width, height].every(n => Number.isSafeInteger(n) && n >= 1 && n <= RASTER_LIMITS.maxSide) || width * height > RASTER_LIMITS.pixels) throw new AutomationError('raster_limit', 'Raster dimensions exceed 16384 per side or 64 MP')
    return kernelExportPlan(bounds, scale)
  })
  if (plans.reduce((sum, p) => sum + p.width * p.height, 0) > RASTER_LIMITS.pixels) throw new AutomationError('raster_limit', 'Raster batch exceeds 64 MP')
  if (typeof Worker !== 'function') throw new AutomationError('renderer_unavailable', 'Product CPU raster export requires a renderer Worker')
  const assets = await exportRasterBatch(doc, pageId, options.scales, target, undefined, signal, options.format)
  signal.throwIfAborted()
  if (assets.length !== plans.length || assets.some((asset, i) => asset.backend !== 'cpu' || asset.blob.type !== `image/${options.format}` || !asset.blob.size || asset.width !== plans[i].width || asset.height !== plans[i].height)) throw new AutomationError('invalid_raster', 'Raster renderer returned inconsistent dimensions or format')
  if (assets.reduce((sum, a) => sum + a.blob.size, 0) > RASTER_LIMITS.bytes) throw new AutomationError('response_limit', 'Encoded raster batch exceeds 64 MiB')
  return { assets, pageId, target: target.kind, bounds, nodeIds: options.nodeIds ?? [], sliceId: options.sliceId, renderer: 'product-cpu-export', screenshot: false }
}
