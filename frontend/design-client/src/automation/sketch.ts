import { export_sketch_json, import_sketch_json } from '../generated/design-kernel/design_kernel'
import { kernelModuleReady } from '../kernel/module'
import { uid, validateDocument, type DesignDocument } from '../model'
import { emptySystem } from '../design-system'
import { importNativeDocument } from './export'
import { AutomationError, type AutomationContext, type AutomationExtension } from './types'
import type { DesignAutomationWarning } from './context'

/** The shared Rust codec enforces ZIP32, path/duplicate checks, CRCs, 4096
 * entries, 16 MiB per entry, 64 MiB expansion and a 200:1 compression ceiling.
 * These are additional JSON transport/admission limits, not a second codec. */
export const SKETCH_LIMITS = Object.freeze({
  transferBytes: 32 * 1024 * 1024 - 64 * 1024,
  documentBytes: 32 * 1024 * 1024 - 64 * 1024,
})
const encoder = new TextEncoder()
const compatibility: DesignAutomationWarning = {
  code: 'SKETCH_COMPATIBILITY',
  message: 'This is an editable Sketch compatibility mapping, not a lossless archive roundtrip or a pixel-fidelity guarantee. Keep the original .sketch file; unsupported source fields, materials, layout, color management and interactions may differ or be omitted.',
}
const fonts: DesignAutomationWarning = {
  code: 'SKETCH_FONT_RESOURCES',
  message: 'The Sketch codec exports font names, not embedded font binaries. Imported fonts without supported embedded resources use the app default; font metrics and line breaks can change.',
}
function requireKernel() {
  if (!kernelModuleReady()) throw new AutomationError('kernel_not_ready', 'The shared Sketch codec is not initialized; wait for the editor to finish loading')
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}
function decodeArchive(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > SKETCH_LIMITS.transferBytes || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value))
    throw new AutomationError('invalid_params', 'Sketch import requires canonical base64 within the 32 MiB transfer budget (64 KiB reserved)')
  const paddingAt = value.indexOf('=')
  if (paddingAt !== -1 && !['=', '=='].includes(value.slice(paddingAt)))
    throw new AutomationError('invalid_params', 'Sketch base64 has invalid padding')
  const binary = atob(value)
  // Reject noncanonical padding bits, not just non-base64 characters.
  if (btoa(binary) !== value) throw new AutomationError('invalid_params', 'Sketch base64 has noncanonical padding bits')
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4)
    throw new AutomationError('invalid_document', 'Sketch input must be a real .sketch ZIP archive; SVG, JSON and .fig bytes are not Sketch files')
  return bytes
}
function readArchive(bytes: Uint8Array) {
  requireKernel()
  let json: string
  try { json = import_sketch_json(bytes) }
  catch (error) { throw new AutomationError('invalid_document', 'The shared Sketch codec rejected the archive', { reason: error instanceof Error ? error.message : String(error) }) }
  if (encoder.encode(json).byteLength > SKETCH_LIMITS.documentBytes)
    throw new AutomationError('response_limit', 'Expanded Sketch document exceeds the 32 MiB editable-document budget')
  return JSON.parse(json) as { document: DesignDocument; warnings: string[] }
}
function codecWarnings(messages: string[]): DesignAutomationWarning[] {
  return messages.map(message => ({ code: 'SKETCH_CODEC_NOTICE', message }))
}
function sourceFontWarnings(document: DesignDocument): DesignAutomationWarning[] {
  const metadata = document.designSystem?.sketchContainers?.nodeMetadata
  if (!metadata || typeof metadata !== 'object') return []
  const names = new Set<string>()
  let omitted = false
  for (const entry of Object.values(metadata)) {
    const encoded = entry?.bindings?.sketchSourceFonts
    if (typeof encoded !== 'string') continue
    const source = JSON.parse(encoded) as { style?: string; fallbacks?: string[]; runs?: Record<string, string> }
    for (const name of [source.style, ...(source.fallbacks ?? []), ...Object.values(source.runs ?? {})]) {
      if (!name || names.has(name)) continue
      if (names.size >= 64 || name.length > 200) { omitted = true; continue }
      names.add(name)
    }
  }
  return names.size || omitted ? [{ code: 'SKETCH_SOURCE_FONTS', message: `Source font names before app-default substitution: ${[...names].sort().map(name => JSON.stringify(name)).join(', ')}.${omitted ? ' Additional names exceed the notice budget; inspect the original archive.' : ''}` }] : []
}

/** Binary import uses the same codec as the editor's file worker, then the
 * existing native append transaction. It never interprets SVG as Sketch or
 * fetches URLs, remote libraries or fonts. All mutation is staged so errors
 * leave both the caller's document and createdIds unchanged. */
export function importSketchDocument(document: DesignDocument, params: Record<string, unknown>, context: AutomationContext) {
  if (Object.keys(params).some(key => !['base64', 'name', 'pageId'].includes(key)))
    throw new AutomationError('invalid_params', 'Sketch import accepts base64, optional name and optional pageId only')
  if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 200))
    throw new AutomationError('invalid_params', 'Sketch name must contain 1–200 characters')
  const report = readArchive(decodeArchive(params.base64))
  // The codec's imported-sketch identity is format-local. The destination
  // keeps its identity and importNativeDocument remaps all imported node IDs.
  report.document.id = uid()
  if (params.name !== undefined) report.document.name = params.name as string
  const draft = structuredClone(document)
  const stagedContext = { ...context, createdIds: [] as string[] }
  const imported = importNativeDocument(draft, { format: 'native-json', document: report.document, pageId: params.pageId }, stagedContext)
  // These two source records are node-local and contain no graph references.
  // Preserve exact native rotation/flip fields under the fresh node identity;
  // the shared exporter checks the stored matrix against current authored
  // geometry before reusing them. Never copy native symbol IDs or raw graphs.
  const sourceMetadata = report.document.designSystem?.sketchContainers?.nodeMetadata
  if (sourceMetadata && typeof sourceMetadata === 'object') {
    for (const [sourceId, entry] of Object.entries(sourceMetadata)) {
      const id = imported.nodeIdMap[sourceId]
      if (!id) continue
      const bindings = Object.fromEntries(['sketchSourceTransform', 'sketchSourceFonts']
        .filter(key => typeof entry?.bindings?.[key] === 'string')
        .map(key => [key, entry.bindings[key]]))
      if (!Object.keys(bindings).length) continue
      const system = draft.designSystem ??= emptySystem()
      const containers = system.sketchContainers ??= {}
      const metadata = containers.nodeMetadata ??= {}
      ;(metadata as Record<string, unknown>)[id] = { bindings, styleRefs: {} }
    }
  }
  const warnings: DesignAutomationWarning[] = [{ ...compatibility }, ...codecWarnings(report.warnings), ...sourceFontWarnings(report.document)]
  if (Object.values(report.document.nodes).some(node => node.kind === 'text')) warnings.push({ ...fonts })
  const omittedSourceContainers = Object.keys(report.document.designSystem?.sketchContainers ?? {}).sort()
  if (omittedSourceContainers.length) warnings.push({
    code: 'SKETCH_APPEND_SOURCE_METADATA',
    message: 'Append keeps editable nodes, remapped component references and node-local source transform/font records. Other opaque Sketch archive metadata and source-layout signatures are not merged; preserve the original archive for native-source fidelity.',
  })
  // Bound the final destination too: multiple individually small imports must
  // not evade the existing shared document admission budget.
  if (encoder.encode(JSON.stringify(draft)).byteLength > SKETCH_LIMITS.documentBytes)
    throw new AutomationError('response_limit', 'Destination document would exceed the 32 MiB editable-document budget')
  Object.assign(document, draft)
  context.createdIds.push(...stagedContext.createdIds)
  return { ...imported, sourceFormat: 'sketch', fidelity: 'compatibility', lossless: false, warnings, omittedSourceContainers }
}

/** Export the whole authored document through the existing WASM binary codec.
 * Reopen its actual bytes before returning them so a rejected archive is never
 * advertised as a successful export. No renderer or browser is involved. */
export function exportSketchDocument(document: DesignDocument) {
  requireKernel()
  validateDocument(document)
  const json = JSON.stringify(document)
  if (encoder.encode(json).byteLength > SKETCH_LIMITS.documentBytes)
    throw new AutomationError('response_limit', 'Sketch export source exceeds the 32 MiB editable-document budget')
  let bytes: Uint8Array
  try { bytes = new Uint8Array(export_sketch_json(json)) }
  catch (error) { throw new AutomationError('unsupported_fidelity', 'The shared Sketch codec could not export this document', { reason: error instanceof Error ? error.message : String(error) }) }
  if (Math.ceil(bytes.byteLength / 3) * 4 > SKETCH_LIMITS.transferBytes)
    throw new AutomationError('response_limit', 'Sketch archive exceeds the 32 MiB base64 transfer budget (64 KiB reserved)')
  const reopened = readArchive(bytes)
  const warnings = [{ ...compatibility }, ...codecWarnings(reopened.warnings)]
  if (Object.keys(document.fonts ?? {}).length || Object.values(document.nodes).some(node => node.kind === 'text')) warnings.push({ ...fonts })
  return {
    format: 'futureox.design-sketch.v1', sourceFormat: 'sketch', filename: 'design.sketch',
    mimeType: 'application/zip', encoding: 'base64', base64: bytesToBase64(bytes), bytes: bytes.byteLength,
    sourceDocumentId: document.id, sourceNodeCount: Object.keys(document.nodes).length,
    fidelity: 'compatibility', lossless: false, warnings,
  }
}

export const sketchExtensions: AutomationExtension[] = [
  { name: 'sketch.import', description: 'Append a real local Sketch ZIP supplied as base64 using the shared binary codec and native ID-remapping transaction. Returns editable nodeIdMap and explicit fidelity/font/source-metadata limitations. No network or filesystem access.', mutates: true,
    inputSchema: { type: 'object', required: ['base64'], properties: { base64: { type: 'string', minLength: 4, maxLength: SKETCH_LIMITS.transferBytes }, name: { type: 'string', minLength: 1, maxLength: 200 }, pageId: { type: 'string' } }, additionalProperties: false }, execute: importSketchDocument },
  { name: 'sketch.export', description: 'Export the whole authored document as a real Sketch ZIP through the shared binary codec, then verify it reopens. Preserves rigid placement; rejects scaled/sheared affine placement. Returns bounded base64 and explicit compatibility limitations; not a lossless Sketch, font-binary or pixel-fidelity guarantee.', mutates: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: exportSketchDocument },
]
