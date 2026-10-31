import { kernelLayout } from './kernel/picking'
import type { DesignDocument } from './model'
import { scene } from './geometry'
import { svgSource } from './export'
import type { ExportTarget } from './export-metadata'
import { validateSvgOptions, svgFileBytes, type SvgExportOptions } from './export-options'
import { readKernelAsset } from './kernel/initialization'
import { EMBEDDED_FONT_WARNING, inspectSvgFont } from './svg-font-embedding'
import { EDITABLE_TEXT_WARNING } from './svg-editable-text'

export const SVG_ARTIFACT_LIMITS = Object.freeze({ fontBytes: 24 * 1024 * 1024, bytes: 64 * 1024 * 1024, estimatedTransientBytes: 256 * 1024 * 1024 })
const base64 = (bytes: Uint8Array) => { let binary = ''; for (let at=0;at<bytes.length;at+=8192) binary += String.fromCharCode(...bytes.subarray(at,at+8192)); return btoa(binary) }
/** The only provider is a fixed bundled same-origin asset, never a font URL from a document. */
export type BundledFontProvider = (signal: AbortSignal) => Promise<Uint8Array>
export const bundledSvgFont: BundledFontProvider = signal => readKernelAsset('/fonts/NotoSansSC.ttf', SVG_ARTIFACT_LIMITS.fontBytes, signal)
export async function createSvgArtifact(document: DesignDocument, pageId: string, target: ExportTarget, input: SvgExportOptions, signal: AbortSignal, loadDefault: BundledFontProvider = bundledSvgFont) {
  const options = validateSvgOptions(input)
  signal.throwIfAborted()
  let doc = kernelLayout(document)
  const entries = scene(doc,pageId).filter(e => target.kind !== 'selection' || target.nodeIds.some(id=>id === e.id || e.ancestors.includes(id)))
  const used = new Set(entries.filter(e=>doc.nodes[e.id].kind === 'text').flatMap(e => { const n=doc.nodes[e.id]; return [n.textStyle?.fontId || 'default', ...(n.textStyle?.fallbacks || []), ...(n.textRuns || []).map(r=>r.fontId || n.textStyle?.fontId || 'default')] }))
  if (entries.some(e=>doc.nodes[e.id].kind === 'text')) used.add('default')
  let embeddedFonts: DesignDocument['fonts']
  let decodedFontBytes = 0
  if (options.fontMode === 'embed') {
    const fonts: NonNullable<DesignDocument['fonts']> = {}
    for (const id of used) {
      if (id === 'default') continue
      const font=doc.fonts?.[id]
      if (!font) throw new Error(`Cannot embed unavailable local font: ${id}`)
      decodedFontBytes += inspectSvgFont(font.data,font.index,SVG_ARTIFACT_LIMITS.fontBytes).bytes
      if (decodedFontBytes > SVG_ARTIFACT_LIMITS.fontBytes) throw new Error('SVG artifact fonts exceed 24 MiB')
      fonts[id]=font
    }
    if (used.has('default')) {
      if (doc.fonts?.__svg_bundled_default) throw new Error('Reserved bundled SVG font ID conflicts with document font')
      const bytes = await loadDefault(signal)
      signal.throwIfAborted()
      if (bytes.length > SVG_ARTIFACT_LIMITS.fontBytes - decodedFontBytes) throw new Error('SVG artifact fonts exceed 24 MiB including bundled default')
      const data=base64(bytes)
      inspectSvgFont(data,0,SVG_ARTIFACT_LIMITS.fontBytes)
      decodedFontBytes += bytes.length
      fonts.__svg_bundled_default={family:'Noto Sans SC',data,index:0}
    }
    if (Object.keys(fonts).length > 32) throw new Error('SVG artifact exceeds 32 fonts including bundled default')
    embeddedFonts=fonts
  }
  // Bound multiple live string copies conservatively: source font bytes, base64
  // UTF-16, serialized XML UTF-16 and UTF-8 output. Blob storage is capped separately.
  const estimatedFontWorkingBytes=decodedFontBytes + Math.ceil(decodedFontBytes/3)*4*6
  if (estimatedFontWorkingBytes > SVG_ARTIFACT_LIMITS.estimatedTransientBytes) throw new Error('SVG artifact font working-memory budget exceeded')
  signal.throwIfAborted()
  let result: ReturnType<typeof svgSource>
  try { result=svgSource(doc,pageId,target,options.scale,options.precision,options.textMode,options.fontMode,options.fontEmbeddingAllowed,SVG_ARTIFACT_LIMITS.fontBytes,embeddedFonts) }
  finally { if (doc !== document) kernelLayout(document) }
  if (result.issues.length) throw new Error(`SVG cannot preserve effects: ${result.issues.join(', ')}`)
  const sourceBytes=new TextEncoder().encode(result.source).byteLength
  if (sourceBytes > SVG_ARTIFACT_LIMITS.bytes || estimatedFontWorkingBytes + sourceBytes*2 > SVG_ARTIFACT_LIMITS.estimatedTransientBytes) throw new Error('SVG artifact exceeds byte or working-memory budget')
  signal.throwIfAborted()
  const bytes=svgFileBytes(result.source,options.compression)
  if (bytes.length > SVG_ARTIFACT_LIMITS.bytes) throw new Error('SVG artifact exceeds 64 MiB')
  signal.throwIfAborted()
  return {blob:new Blob([new Uint8Array(bytes).buffer],{type:'image/svg+xml'}),name:options.compression === 'gzip' ? 'design.svgz' : 'design.svg',bounds:result.box,options,decodedFontBytes,sourceBytes,estimatedFontWorkingBytes,warnings:options.textMode === 'editable' ? [{code:'SVG_EDITABLE_TEXT',message:options.fontMode === 'embed' ? EMBEDDED_FONT_WARNING : EDITABLE_TEXT_WARNING}] : []}
}
