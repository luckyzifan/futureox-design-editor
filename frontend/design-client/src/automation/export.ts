import { EMBEDDED_FONT_WARNING } from '../svg-font-embedding'
import { hasLogic } from '../prototype-logic'
import { EDITABLE_TEXT_WARNING } from '../svg-editable-text'
import { importSvg } from '../import-svg'
import { SVG_OPTION_SCHEMA, validateSvgOptions, svgFileBytes, decodeSvgFileBytes, type SvgExportOptions } from '../export-options'
import { encodeDocumentBinary, decodeDocumentBinary } from '../kernel/binfmt'
import { svgSource } from '../export'
import { appendDocument } from '../append-document'
import { validateDocument } from '../model'
import { kernelLayout, kernelExportPlan, prepareDocumentForEditing } from '../kernel/picking'
import type { DesignDocument, DesignNode, Paint, TextRun } from '../model'
import { AutomationError, type AutomationExtension, type AutomationContext } from './types'
import {
  assetReference, boundedInteger, collectAssetReferences, contextEntries, contextOptions,
  safeWebUrl, type AssetReference, type ContextOptions, type DesignAutomationWarning,
} from './context'

export type CodeExportOptions = Pick<ContextOptions, 'pageId' | 'nodeIds'> & { maxNodes?: number }
export type CodeAsset = AssetReference & { path: string; emitted: boolean; dataUrl?: string }
export const EXPORT_LIMITS = Object.freeze({ nodes: 500, bytes: 8 * 1024 * 1024, nativeBytes: 32 * 1024 * 1024 - 64 * 1024, embeddedAsset: 256 * 1024, embeddedTotal: 2 * 1024 * 1024, previewPixels: 16 * 1024 * 1024 })
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const cssString = (value: string) => `"${Array.from(value, char => /^[a-z\d _-]$/i.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `).join('')}"`
const number = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new AutomationError('invalid_params', 'Export contains invalid geometry')
  return String(Math.round(value * 1e6) / 1e6)
}
const px = (value: number) => `${number(value)}px`
function cssColor(value: string): string | undefined {
  if (/^#[\da-f]{3,4}$/i.test(value) || /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value.toLowerCase()
  if (/^(?:transparent|black|white|red|green|blue|gray|grey|currentcolor)$/i.test(value)) return value.toLowerCase()
  if (/^(?:rgb|rgba|hsl|hsla)\([\d.,%+\-\s/]+\)$/i.test(value)) return value
  if (/^color\((?:srgb|display-p3)\s+[\d.%+\-\s/]+\)$/i.test(value)) return value
  return undefined
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  }, 2)
}
export function exportNativeDocument(document: DesignDocument) {
  const content = stableJson(document)
  const bytes = new TextEncoder().encode(content).byteLength
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > EXPORT_LIMITS.nativeBytes) throw new AutomationError('invalid_params', 'Native document exceeds the 32 MiB automation transfer budget (64 KiB reserved); use the existing native file export')
  return { format: 'futureox.design-document.v1', nativeFormat: 'native-json', encoding: 'utf8', mimeType: 'application/json', filename: 'design.json', content, bytes, schemaVersion: document.schemaVersion, lossless: true }
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}
export function exportBinaryDocument(document: DesignDocument) {
  const bytes = encodeDocumentBinary(document)
  // Reserve room for the response envelope; base64 expands actual binfmt bytes.
  if (Math.ceil(bytes.byteLength / 3) * 4 > EXPORT_LIMITS.nativeBytes) throw new AutomationError('response_limit', 'Native .fd exceeds the 32 MiB automation transfer budget (64 KiB reserved); use the existing native file export')
  return { format: 'futureox.design-document.v1', nativeFormat: 'fd', encoding: 'base64', mimeType: 'application/vnd.futureox-desgin', filename: 'design.fd', base64: bytesToBase64(bytes), bytes: bytes.byteLength, schemaVersion: document.schemaVersion, lossless: true }
}
function assertSafeImportTree(value: unknown) {
  const pending = [value]; let visited = 0
  while (pending.length) {
    const next = pending.pop()
    if (++visited > 1000000) throw new AutomationError('invalid_params', 'Import exceeds structural budget')
    if (!next || typeof next !== 'object') continue
    for (const [key, item] of Object.entries(next)) {
      if (['__proto__', 'constructor'].includes(key)) throw new AutomationError('invalid_params', `Unsafe import key: ${key}`)
      pending.push(item)
    }
  }
}
/** Shared bounded native decoding only. Callers choose native storage admission
 * or editing preparation; decoding never switches fonts, appends or activates. */
export function decodeNativeImportDocument(params: Record<string, unknown>): unknown {
  if (!['native-json', 'fd'].includes(String(params.format))) throw new AutomationError('unsupported_format', 'document.import supports fd and native-json append only; HTML cannot be losslessly imported')
  let value: unknown
  if (params.format === 'fd') {
    if (params.content !== undefined || params.document !== undefined || typeof params.base64 !== 'string') throw new AutomationError('invalid_params', 'fd import requires base64 only')
    const paddingAt = params.base64.indexOf('=')
    if (!params.base64.length || params.base64.length > EXPORT_LIMITS.nativeBytes || params.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(params.base64) || (paddingAt !== -1 && !['=', '=='].includes(params.base64.slice(paddingAt)))) throw new AutomationError('invalid_params', 'Invalid or oversized fd base64')
    const binary = atob(params.base64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    try { value = decodeDocumentBinary(bytes) } catch (error) { throw new AutomationError('invalid_document', 'Invalid .fd binary or checksum', { reason: error instanceof Error ? error.message : String(error) }) }
  } else {
    if (params.base64 !== undefined || (params.content === undefined) === (params.document === undefined)) throw new AutomationError('invalid_params', 'Provide exactly one of content or document for native-json')
    if (params.content !== undefined && typeof params.content !== 'string') throw new AutomationError('invalid_params', 'content must be native JSON text')
    const encoded = params.content as string | undefined ?? JSON.stringify(params.document)
    if (!encoded || new TextEncoder().encode(encoded).byteLength > EXPORT_LIMITS.nativeBytes) throw new AutomationError('invalid_params', 'Import exceeds the 32 MiB transfer budget (64 KiB reserved)')
    try { value = JSON.parse(encoded) } catch { throw new AutomationError('invalid_params', 'Import is not valid JSON') }
  }
  assertSafeImportTree(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EXPORT_LIMITS.nativeBytes) throw new AutomationError('invalid_params', 'Expanded native document exceeds the 32 MiB budget')
  return value
}
/** Append through the existing importer; preserve identity and remap the graph. */
export function importNativeDocument(document: DesignDocument, params: Record<string, unknown>, context: AutomationContext) {
  const value = decodeNativeImportDocument(params)
  const options = contextOptions({ pageId: params.pageId }, context.pageId)
  const source = prepareDocumentForEditing(value)
  let draft = structuredClone(document)
  const previousIds = new Set(Object.keys(draft.nodes))
  const rootIds = appendDocument(draft, source, options.pageId!)
  // Instance descendants derive IDs from their newly remapped owner. Resolve
  // them before building the public mapping, just as the commit boundary does.
  draft = prepareDocumentForEditing(draft)
  validateDocument(draft)
  const nodeIdMap: Record<string, string> = Object.create(null)
  const pages = source.pages.filter(p => p.children.length)
  const pending = pages.flatMap((page, index) => page.children.map((id, i) => [id, draft.nodes[rootIds[index]].children[i]] as const))
  while (pending.length) {
    const [oldId, newId] = pending.pop()!
    if (Object.hasOwn(nodeIdMap, oldId)) continue
    nodeIdMap[oldId] = newId
    source.nodes[oldId].children.forEach((id, index) => pending.push([id, draft.nodes[newId].children[index]]))
  }
  const createdIds = Object.keys(draft.nodes).filter(id => !previousIds.has(id))
  Object.assign(document, draft)
  context.createdIds.push(...createdIds)
  return { format: 'futureox.design-import.v1', mode: 'append', documentId: document.id, pageId: options.pageId, rootIds, nodeIdMap, createdIds }
}
function codeOptions(params: Record<string, unknown>, pageId?: string): CodeExportOptions {
  const options = contextOptions({ pageId: params.pageId, nodeIds: params.nodeIds }, pageId)
  return { pageId: options.pageId, nodeIds: options.nodeIds, maxNodes: boundedInteger(params.maxNodes, 200, 1, EXPORT_LIMITS.nodes, 'maxNodes') }
}
/** Semantic, editable HTML, not a screenshot renderer. Resolved kernel layout,
 * component materialization and token values remain the source of truth. Every
 * approximation has an explicit fidelity warning instead of a silent fallback. */
export function exportDesignCode(document: DesignDocument, input: CodeExportOptions = {}) {
  const options = codeOptions(input as Record<string, unknown>)
  const source = contextEntries(document, { ...options, maxDepth: 64, limit: 500 })
  if (source.omittedByDepth) throw new AutomationError('invalid_params', 'Code export exceeds 64 levels; select a smaller subtree')
  if (source.entries.length > options.maxNodes!) throw new AutomationError('invalid_params', `Code export exceeds maxNodes (${options.maxNodes}); select a smaller subtree`)
  const resolved = kernelLayout(document)
  const { entries, roots, page, omittedByDepth } = contextEntries(resolved, { ...options, maxDepth: 64, limit: 500 })
  if (entries.length > options.maxNodes! || omittedByDepth) throw new AutomationError('invalid_params', 'Resolved component subtree exceeds export limits; select a smaller subtree')
  const warnings: DesignAutomationWarning[] = []
  const warn = (code: string, message: string, nodeId?: string) => {
    if (!warnings.some(w => w.code === code && w.nodeId === nodeId)) warnings.push({ code, message, ...(nodeId ? { nodeId } : {}) })
  }
  warn('APPROXIMATE_HTML', 'HTML/CSS is an editable approximation. Use preview.capture or native export for renderer-faithful pixels; no pixel-equivalence claim is made.')
  if (document.colorManagement) warn('COLOR_MANAGEMENT', 'Browser CSS does not reproduce native HDR, tone mapping or color-managed compositing.')
  if (document.animations?.length || document.prototype) warn('INTERACTIONS_NOT_EXPORTED', 'Animation timelines and prototype interactions remain in the native document; no executable script is generated.')
  if (Object.values(document.prototype?.interactions || {}).some(events => events.some(e => hasLogic(e.actions)))) warn('PROTOTYPE_LOGIC_NOT_EXPORTED', 'Typed expressions, nested branches and runtime variable assignments run only in the native Web/Electron prototype preview. HTML/CSS export is static; native .fd retains this logic.')
  const assetIdentities = new Map<string, string>()
  const assets = collectAssetReferences(entries, assetIdentities).map<CodeAsset>(asset => ({ ...asset, path: `assets/${asset.id}.${asset.mediaType?.split('/')[1] === 'jpeg' ? 'jpg' : asset.mediaType?.split('/')[1] ?? 'image'}`, emitted: false }))
  const assetsById = new Map(assets.map(asset => [asset.id, asset]))
  let embeddedBytes = 0
  for (const { node } of entries) for (const paint of [...node.fills, ...node.strokes.map(s => s.paint)]) {
    if (!paint.image) continue
    const asset = assetsById.get(assetReference(paint.image, node.id, paint.id, assetIdentities).id)
    if (!asset || asset.emitted) continue
    if (asset.source === 'embedded' && paint.image.length <= EXPORT_LIMITS.embeddedAsset && embeddedBytes + paint.image.length <= EXPORT_LIMITS.embeddedTotal) {
      asset.dataUrl = paint.image; asset.emitted = true; embeddedBytes += paint.image.length
    } else if (asset.source === 'remote') { asset.emitted = true }
    else warn(asset.source === 'unsafe' ? 'UNSAFE_ASSET_URL' : 'ASSET_NOT_EMBEDDED', 'Image source is not portable or exceeds inline limits. The manifest identifies the original node/paint; retrieve it from the native document.', node.id)
  }
  const nodeIdMap: Record<string, { elementId: string; selector: string }> = Object.create(null)
  entries.forEach(({ node }, index) => { nodeIdMap[node.id] = { elementId: `design-node-${index + 1}`, selector: `#design-node-${index + 1}` } })
  const styles: string[] = ['*{box-sizing:border-box}', 'html,body{margin:0;padding:0}', '.design-scene{position:relative;isolation:isolate}', '.design-node{position:absolute;transform-origin:0 0}', '.design-text{margin:0;white-space:pre-wrap;overflow-wrap:normal}']
  const included = new Set(entries.map(e => e.node.id))
  const safeColor = (value: string, nodeId: string) => {
    const safe = cssColor(value)
    if (!safe) warn('UNSUPPORTED_COLOR', 'Unrecognized color syntax was omitted for safe CSS export.', nodeId)
    return safe
  }
  const paintCss = (paint: Paint, nodeId: string): string | undefined => {
    if (paint.blend !== 'normal' || paint.opacity !== 1) warn('PAINT_COMPOSITING', 'Per-paint blend and opacity may differ from the native compositor.', nodeId)
    if (paint.kind === 'solid') {
      const color = safeColor(paint.color, nodeId)
      return color && (paint.opacity === 1 ? color : `color-mix(in srgb, ${color} ${number(Math.max(0, Math.min(1, paint.opacity)) * 100)}%, transparent)`)
    }
    if (paint.kind === 'image') {
      const asset = paint.image && assetsById.get(assetReference(paint.image, nodeId, paint.id, assetIdentities).id)
      if (paint.transform || paint.tile || paint.adjust) warn('IMAGE_TRANSFORM', 'Image transforms, pattern tiling and color adjustments are not reproduced by CSS background sizing.', nodeId)
      const uri = asset && (asset.dataUrl ?? asset.uri)
      return uri ? `url(${cssString(uri)})` : undefined
    }
    if (paint.kind === 'linear' || paint.kind === 'radial') {
      if (paint.stops.length > 64) { warn('GRADIENT_LIMIT', 'Gradient with more than 64 stops was omitted.', nodeId); return }
      warn('GRADIENT_APPROXIMATION', 'CSS gradient coordinates and interpolation can differ from native rendering.', nodeId)
      const stops = paint.stops.map(stop => { const c = safeColor(stop.color, nodeId); return c ? `${c} ${number(stop.offset * 100)}%` : undefined }).filter(Boolean)
      return stops.length ? `${paint.kind === 'linear' ? `linear-gradient(${number(paint.angle)}deg,` : 'radial-gradient(ellipse at center,'}${stops.join(',')})` : undefined
    }
    warn('UNSUPPORTED_GRADIENT', `${paint.kind} gradients are not supported in semantic HTML export.`, nodeId)
  }
  const align: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' }
  const rootSet = new Set(roots)
  // Keep selected roots in their authored parent coordinate system. Different
  // parents require world composition, so explicitly report this limitation.
  if (new Set(entries.filter(e => rootSet.has(e.node.id)).map(e => e.parentId)).size > 1)
    warn('MULTIPLE_PARENT_SPACES', 'Selected roots have different parent spaces; each root keeps its local transform. Export a common ancestor for a spatially aligned composition.')
  let right = 1, bottom = 1
  for (const { node, parentId } of entries) {
    const n = node, selector = nodeIdMap[n.id].selector, declarations: string[] = []
    const parent = parentId && !rootSet.has(n.id) ? resolved.nodes[parentId] : undefined
    const flow = !!parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute
    declarations.push(`width:${px(n.width)}`, `height:${px(n.height)}`, `opacity:${number(n.opacity)}`)
    if (!n.visible || n.kind === 'slice') declarations.push('display:none')
    const matrix = [...n.transform]
    if (flow) {
      declarations.push('position:relative', 'flex-shrink:0')
      matrix[4] = 0; matrix[5] = 0
      if (n.sizing?.width === 'fill' && parent!.layout!.mode === 'horizontal') declarations.push('flex:1 1 0', 'min-width:0')
      if (n.sizing?.height === 'fill' && parent!.layout!.mode === 'vertical') declarations.push('flex:1 1 0', 'min-height:0')
      if (n.sizing?.alignSelf) declarations.push(`align-self:${align[n.sizing.alignSelf]}`)
      if (parent!.layout!.mode === 'grid') declarations.push(`grid-column:span ${number(n.sizing?.columnSpan ?? 1)}`, `grid-row:span ${number(n.sizing?.rowSpan ?? 1)}`)
    }
    declarations.push(`transform:matrix(${matrix.map(number).join(',')})`)
    if (rootSet.has(n.id)) { right = Math.max(right, n.transform[4] + n.width); bottom = Math.max(bottom, n.transform[5] + n.height) }
    if (n.clip) declarations.push('overflow:hidden')
    if (n.blend !== 'normal' && n.blend !== 'pass-through') {
      if (['linear-burn', 'linear-dodge'].includes(n.blend)) warn('UNSUPPORTED_BLEND', `${n.blend} blend is omitted.`, n.id)
      else declarations.push(`mix-blend-mode:${n.blend}`)
    }
    if (n.blend === 'pass-through') warn('PASS_THROUGH_COMPOSITING', 'Pass-through group compositing is approximated by DOM stacking.', n.id)
    if (n.mask || n.booleanOperation) warn('MASK_OR_BOOLEAN', 'Mask and boolean geometry is not reproduced; the source graph is retained in native export.', n.id)
    if (n.smoothing) warn('CORNER_SMOOTHING', 'Continuous corner smoothing is approximated by CSS border-radius.', n.id)
    if (n.kind === 'ellipse') declarations.push('border-radius:50%')
    else declarations.push(`border-radius:${n.radii.map(px).join(' ')}`)
    if (n.repeat) warn('REPEAT_TRANSFORMS_NOT_EXPORTED', 'Semantic HTML includes only the editable source, not its derived repeat appearances. Use native FD/JSON to preserve the repeat, or PNG/SVG/PDF for visual output.', n.id)
    if (n.arc || n.textPath || n.pathOffset || n.vectorBrush) warn('SPECIAL_GEOMETRY', 'Arc, text-on-path, path-offset and vector-brush geometry is not reproduced in HTML.', n.id)
    if (['vector', 'polygon', 'star', 'line'].includes(n.kind)) {
      warn('UNSUPPORTED_SHAPE', `${n.kind} geometry uses a bounding-box placeholder; use native SVG/image export for its exact shape.`, n.id)
      declarations.push('outline:1px dashed #999')
    }
    const fills = n.fills.filter(p => p.visible).slice(0, 16)
    if (n.fills.length > 16) warn('PAINT_LIMIT', 'Only the first 16 visible fills are exported.', n.id)
    if (n.kind === 'text') {
      const color = fills.find(p => p.kind === 'solid')
      if (color) { const safe = paintCss(color, n.id); if (safe) declarations.push(`color:${safe}`) }
      if (fills.length > 1 || fills.some(p => p.kind !== 'solid')) warn('TEXT_PAINTS', 'Text export uses one solid fill; additional text paints are omitted.', n.id)
    } else {
      const layers = fills.map(p => { const value = paintCss(p, n.id); return value && p.kind === 'solid' ? `linear-gradient(${value},${value})` : value }).filter(Boolean)
      if (layers.length) declarations.push(`background-image:${layers.reverse().join(',')}`)
      const image = fills.find(p => p.kind === 'image')
      if (image) declarations.push(`background-size:${image.fit === 'stretch' ? '100% 100%' : image.fit}`, 'background-position:center', 'background-repeat:no-repeat')
    }
    const strokes = n.strokes.filter(s => s.visible && s.paint.visible)
    const stroke = strokes[0]
    if (stroke?.paint.kind === 'solid') {
      const color = paintCss(stroke.paint, n.id)
      if (color) declarations.push(`border:${px(stroke.width)} solid ${color}`)
    }
    if (strokes.length) warn('STROKE_APPROXIMATION', 'CSS border approximates strokes; alignment, multiple strokes, dashes, joins, markers and width profiles may differ.', n.id)
    const shadows: string[] = [], filters: string[] = [], backdrop: string[] = []
    for (const effect of n.effects.filter(e => e.visible)) {
      if (effect.kind === 'shadow' || effect.kind === 'inner-shadow') {
        const color = safeColor(effect.color, n.id)
        if (color) shadows.push(`${effect.kind === 'inner-shadow' ? 'inset ' : ''}${px(effect.x)} ${px(effect.y)} ${px(effect.radius)} ${px(effect.spread)} color-mix(in srgb, ${color} ${number(effect.opacity * 100)}%, transparent)`)
        warn('EFFECT_APPROXIMATION', 'Browser CSS shadow and blur kernels differ from the native compositor.', n.id)
      } else if ((effect.kind === 'blur' || effect.kind === 'background-blur') && !effect.gradientBlur) {
        ;(effect.kind === 'blur' ? filters : backdrop).push(`blur(${px(effect.radius)})`)
        warn('EFFECT_APPROXIMATION', 'Browser CSS shadow and blur kernels differ from the native compositor.', n.id)
      } else warn('UNSUPPORTED_EFFECT', `${effect.kind}${effect.gradientBlur ? ' with gradient blur' : ''} is omitted; native material parameters remain in semantic context and canonical export.`, n.id)
    }
    if (shadows.length) declarations.push(`box-shadow:${shadows.join(',')}`)
    if (filters.length) declarations.push(`filter:${filters.join(' ')}`)
    if (backdrop.length) declarations.push(`backdrop-filter:${backdrop.join(' ')}`)
    if (n.layout && n.layout.mode !== 'none') {
      const l = n.layout
      declarations.push(`display:${n.visible ? l.mode === 'grid' ? 'grid' : 'flex' : 'none'}`, `padding:${l.padding.map(px).join(' ')}`, `gap:${px(l.mode === 'vertical' ? l.gap : l.lineGap)} ${px(l.mode === 'vertical' ? l.lineGap : l.gap)}`, `justify-content:${align[l.justify]}`, `align-items:${align[l.align]}`)
      if (l.mode === 'grid') declarations.push(`grid-template-columns:repeat(${number(l.columns)},minmax(0,1fr))`)
      else declarations.push(`flex-direction:${l.mode === 'horizontal' ? 'row' : 'column'}`, `flex-wrap:${l.wrap ? 'wrap' : 'nowrap'}`)
      warn('LAYOUT_APPROXIMATION', 'CSS flex/grid uses resolved dimensions but may size and wrap differently from the design layout engine.', n.id)
    }
    if (n.kind === 'text') {
      const s = n.textStyle
      const font = s?.fontId ? document.fonts?.[s.fontId] : undefined
      declarations.push(`font-size:${px(n.fontSize)}`, `font-family:${font ? `${cssString(font.family)},sans-serif` : 'sans-serif'}`, `font-weight:${number(s?.weight ?? 400)}`, `line-height:${number(s?.lineHeight ?? 1.35)}`, `letter-spacing:${px(s?.letterSpacing ?? 0)}`, `text-align:${s?.align ?? 'start'}`, `white-space:${s?.wrap ? 'pre-wrap' : 'pre'}`)
      if (s?.direction && s.direction !== 'auto') declarations.push(`direction:${s.direction}`)
      if (s?.writingMode === 'vertical') declarations.push('writing-mode:vertical-rl')
      if (s?.textCase && s.textCase !== 'original') declarations.push(`text-transform:${s.textCase === 'upper' ? 'uppercase' : 'lowercase'}`)
      warn('FONT_METRICS', 'HTML uses installed browser fonts; embedded font binaries, native shaping, OpenType features and paragraph metrics are not exported.', n.id)
    }
    styles.push(`${selector}{${declarations.join(';')}}`)
  }
  styles.push(`.design-scene{width:${px(right)};height:${px(bottom)};background:${cssColor(page.background) ?? 'transparent'}}`)
  const renderText = (n: DesignNode) => {
    if (!n.textRuns?.length) return htmlEscape(n.text)
    if (n.textRuns.length > 128) { warn('TEXT_RUN_LIMIT', 'More than 128 text runs: plain text retained; run formatting omitted.', n.id); return htmlEscape(n.text) }
    const runs = n.textRuns.filter(r => r.end > r.start && r.start >= 0 && r.end <= n.text.length)
    const cuts = [...new Set([0, n.text.length, ...runs.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b)
    return cuts.slice(0, -1).map((start, index) => {
      const end = cuts[index + 1], run = Object.assign({}, ...runs.filter(r => r.start <= start && r.end >= end)) as Partial<TextRun>
      const declarations: string[] = [], className = `${nodeIdMap[n.id].elementId}-run-${index}`
      if (run.color) { const c = safeColor(run.color, n.id); if (c) declarations.push(`color:${c}`) }
      if (run.fontSize !== undefined) declarations.push(`font-size:${px(run.fontSize)}`)
      if (run.weight !== undefined) declarations.push(`font-weight:${number(run.weight)}`)
      if (run.fontId && document.fonts?.[run.fontId]) declarations.push(`font-family:${cssString(document.fonts[run.fontId].family)},sans-serif`)
      if (run.underline || run.strikethrough) declarations.push(`text-decoration:${[run.underline && 'underline', run.strikethrough && 'line-through'].filter(Boolean).join(' ')}`)
      if (run.textCase && run.textCase !== 'original') declarations.push(`text-transform:${run.textCase === 'upper' ? 'uppercase' : 'lowercase'}`)
      if (declarations.length) styles.push(`.${className}{${declarations.join(';')}}`)
      const text = htmlEscape(n.text.slice(start, end)), link = run.link && safeWebUrl(run.link)
      if (run.link && !link) warn('UNSAFE_LINK', 'A non-HTTP(S) or unsafe text link was omitted; its text remains.', n.id)
      return link ? `<a class="${className}" href="${htmlEscape(link)}" rel="noopener noreferrer">${text}</a>` : `<span class="${className}">${text}</span>`
    }).join('')
  }
  // Post-order assembly avoids recursive calls on arbitrary document objects.
  const markup = new Map<string, string>()
  for (const { node: n } of [...entries].reverse()) {
    const content = (n.kind === 'text' ? renderText(n) : '') + n.children.filter(id => included.has(id)).map(id => markup.get(id) ?? '').join('')
    markup.set(n.id, `<div id="${nodeIdMap[n.id].elementId}" class="design-node${n.kind === 'text' ? ' design-text' : ''}" data-node-id="${htmlEscape(n.id)}" data-node-kind="${htmlEscape(n.kind)}" aria-label="${htmlEscape(n.name)}">${content}</div>`)
  }
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data: https: http:; script-src 'none'; object-src 'none'; base-uri 'none'"><title>${htmlEscape(document.name)}</title><link rel="stylesheet" href="styles.css"></head><body><main class="design-scene">${roots.map(id => markup.get(id) ?? '').join('')}</main></body></html>`
  const css = `${styles.join('\n')}\n`
  const result = { format: 'futureox.design-code.v1', language: 'html-css', html, css, nodeIdMap, assets, warnings, fidelity: 'approximate', sourceDocumentId: document.id, pageId: page.id }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > EXPORT_LIMITS.bytes) throw new AutomationError('invalid_params', 'Code export exceeds 8 MiB; select a smaller subtree')
  return result
}

/** Vector serialization reuses the existing native SVG path exporter. Unsupported
 * effects are rejected, never silently rasterized or claimed to be editable SVG. */
export function exportDesignSvg(document: DesignDocument, input: CodeExportOptions & SvgExportOptions = {}) {
  for (const key of Object.keys(input)) if (!['pageId', 'nodeIds', 'maxNodes', 'scale', 'precision', 'compression', 'textMode', 'fontMode', 'fontEmbeddingAllowed'].includes(key)) throw new AutomationError('invalid_params', `Unsupported SVG option: ${key}`)
  let svgOptions: ReturnType<typeof validateSvgOptions>
  try { svgOptions = validateSvgOptions({ scale: input.scale, precision: input.precision, compression: input.compression, textMode: input.textMode, fontMode: input.fontMode, fontEmbeddingAllowed: input.fontEmbeddingAllowed }) } catch (error) { throw new AutomationError('invalid_params', String(error)) }
  const options = codeOptions(input as Record<string, unknown>)
  const resolved = kernelLayout(document)
  const selected = contextEntries(resolved, { ...options, maxDepth: 64 })
  if (selected.entries.length > options.maxNodes! || selected.omittedByDepth) throw new AutomationError('response_limit', 'SVG export scope exceeds node/depth limits')
  for (const { node } of selected.entries) for (const paint of [...node.fills, ...node.strokes.map(s => s.paint)]) {
    if (!paint.image) continue
    const source = assetReference(paint.image, node.id, paint.id)
    if (source.source === 'unsafe' || source.source === 'local') throw new AutomationError('unsafe_asset_url', 'SVG contains a nonportable or unsafe image URL; use native document export')
  }
  const target = options.nodeIds ? { kind: 'selection' as const, nodeIds: selected.roots } : { kind: 'page' as const, padding: 0 }
  let result: ReturnType<typeof svgSource>
  try { result = svgSource(resolved, selected.page.id, target, svgOptions.scale, svgOptions.precision, svgOptions.textMode, svgOptions.fontMode, svgOptions.fontEmbeddingAllowed) } catch (error) { throw new AutomationError('invalid_params', String(error)) }
  if (result.issues.length) throw new AutomationError('unsupported_fidelity', 'SVG cannot faithfully represent this scope; use preview.capture or native document export', { issues: result.issues })
  if (new TextEncoder().encode(result.source).byteLength > EXPORT_LIMITS.bytes) throw new AutomationError('response_limit', 'SVG exceeds 8 MiB')
  const payload = svgOptions.compression === 'gzip' ? { filename: 'design.svgz', encoding: 'base64', base64: bytesToBase64(svgFileBytes(result.source, 'gzip')) } : { filename: 'design.svg', encoding: 'utf8', content: result.source }
  const output = { format: 'futureox.design-vector.v1', mimeType: 'image/svg+xml', ...payload, options: svgOptions, precisionLossy: svgOptions.precision !== undefined, bounds: result.box, sourceNodeIds: selected.roots, warnings: [...(svgOptions.textMode === 'editable' ? [{ code: 'SVG_EDITABLE_TEXT', message: svgOptions.fontMode === 'embed' ? EMBEDDED_FONT_WARNING : EDITABLE_TEXT_WARNING }] : []), ...(svgOptions.precision === undefined ? [] : [{ code: 'SVG_PRECISION_LOSS', message: 'Opt-in decimal rounding changes geometry and may merge nearby points; this is not lossless native export.' }]), { code: 'SVG_NODE_MAPPING', message: 'Source root IDs identify this export scope. Native SVG path and definition IDs are internal and are not a DOM editing API.' }] }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > EXPORT_LIMITS.bytes) throw new AutomationError('response_limit', 'SVG response exceeds 8 MiB including encoding and metadata')
  return output
}

export const PREVIEW_LIMITS = Object.freeze({ pixels: EXPORT_LIMITS.previewPixels, maxSide: 16384, responseBytes: EXPORT_LIMITS.bytes, envelopeBytes: 64 * 1024, nodeIds: 256, minScale: 0.1, maxScale: 4 })
export type PreviewOptions = Pick<ContextOptions, 'pageId' | 'nodeIds'> & { format?: 'png' | 'jpeg' | 'webp'; scale?: number; signal?: AbortSignal }
/** Actual product CPU raster export, not the displayed GPU canvas or app chrome.
 * Never falls back to SVG/DOM rasterization when the product renderer fails. */
export async function captureDesignPreview(document: DesignDocument, options: PreviewOptions = {}) {
  options.signal?.throwIfAborted()
  const selection = contextEntries(document, { ...options, maxDepth: 0 })
  const format = options.format ?? 'png', scale = options.scale ?? 1
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new AutomationError('invalid_params', 'Preview format must be png, jpeg or webp')
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < PREVIEW_LIMITS.minScale || scale > PREVIEW_LIMITS.maxScale) throw new AutomationError('invalid_params', 'Preview scale must be between 0.1 and 4')
  if (options.nodeIds && options.nodeIds.length > PREVIEW_LIMITS.nodeIds) throw new AutomationError('invalid_params', 'Preview supports at most 256 node ids')
  const { exportImage, targetBounds } = await import('../export')
  options.signal?.throwIfAborted()
  const prepared = kernelLayout(document)
  const target = options.nodeIds ? { kind: 'selection' as const, nodeIds: selection.roots } : { kind: 'page' as const, padding: 0 }
  const bounds = targetBounds(prepared, selection.page.id, target)
  const plannedWidth = Math.ceil(bounds.width * scale), plannedHeight = Math.ceil(bounds.height * scale)
  if (![plannedWidth, plannedHeight].every(Number.isSafeInteger) || plannedWidth > PREVIEW_LIMITS.maxSide || plannedHeight > PREVIEW_LIMITS.maxSide || plannedWidth * plannedHeight > PREVIEW_LIMITS.pixels) throw new AutomationError('preview_limit', 'Preview exceeds 16 megapixels or 16384 pixels per side; select a smaller region or explicit lower scale')
  const { width, height } = kernelExportPlan(bounds, scale)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > PREVIEW_LIMITS.pixels) throw new AutomationError('preview_limit', 'Preview exceeds 16 megapixels; select a smaller region or explicit lower scale')
  if (typeof Worker !== 'function') throw new AutomationError('renderer_unavailable', 'Product CPU export requires the mounted renderer Worker runtime; no substitute image was generated')
  const result = await exportImage(prepared, selection.page.id, format, scale, undefined, options.signal, target)
  options.signal?.throwIfAborted()
  if (result.backend !== 'cpu' || result.blob.type !== `image/${format}` || result.width !== width || result.height !== height) throw new AutomationError('invalid_preview', 'Product export returned inconsistent renderer, media type or dimensions')
  // The transport carries base64, not raw binary. Reserve envelope/ID metadata
  // before reading or expanding the Blob, then check the exact serialized result.
  if (!result.blob.size || 4 * Math.ceil(result.blob.size / 3) > PREVIEW_LIMITS.responseBytes - PREVIEW_LIMITS.envelopeBytes) throw new AutomationError('response_limit', 'Encoded preview exceeds the 8 MiB transport budget; lower scale or narrow the selection')
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  options.signal?.throwIfAborted()
  const preview = {
    format: 'futureox.design-preview.v1', documentId: document.id, pageId: selection.page.id, nodeIds: selection.roots,
    target: target.kind, bounds, mimeType: result.blob.type, name: result.name, bytes: bytes.byteLength,
    dataUrl: `data:${result.blob.type};base64,${bytesToBase64(bytes)}`, width, height, scale,
    backend: result.backend, renderer: 'product-cpu-export', screenshot: false,
    warnings: [{ code: 'CPU_EXPORT_PREVIEW', message: 'Product CPU raster export of design content. Does not capture app chrome, selection overlays or the displayed GPU canvas; GPU/display pixel equivalence is not asserted.' }] as DesignAutomationWarning[],
  }
  if (new TextEncoder().encode(JSON.stringify(preview)).byteLength > PREVIEW_LIMITS.responseBytes - PREVIEW_LIMITS.envelopeBytes) throw new AutomationError('response_limit', 'Preview metadata and encoded pixels exceed the transport budget; lower scale or narrow the selection')
  options.signal?.throwIfAborted()
  return preview
}
export function importDesignSvg(document: DesignDocument, params: Record<string, unknown>, context: AutomationContext) {
  const format = params.format ?? 'svg'
  if (!['svg', 'svgz'].includes(String(format))) throw new AutomationError('invalid_params', 'SVG import format must be svg or svgz')
  let source: string
  try {
    if (format === 'svgz') {
      if (params.content !== undefined || typeof params.base64 !== 'string' || !params.base64.length || params.base64.length > EXPORT_LIMITS.bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.base64)) throw new Error('SVGZ requires bounded valid base64 only')
      source = decodeSvgFileBytes(Uint8Array.from(atob(params.base64), c => c.charCodeAt(0)), true)
    } else {
      if (params.base64 !== undefined || typeof params.content !== 'string') throw new Error('SVG requires content text only')
      source = decodeSvgFileBytes(new TextEncoder().encode(params.content))
    }
    if (typeof DOMParser !== 'function') throw new AutomationError('renderer_unavailable', 'SVG import requires the mounted XML parser runtime')
    const imported = importSvg(source, typeof params.name === 'string' ? params.name : 'Imported SVG', document.fonts)
    const result = importNativeDocument(document, { format: 'native-json', document: imported.document, pageId: params.pageId }, context)
    return { ...result, sourceFormat: format, warnings: imported.warnings, lossless: false }
  } catch (error) {
    if (error instanceof AutomationError) throw error
    throw new AutomationError('invalid_document', `SVG import failed: ${String(error)}`)
  }
}

export const exportExtensions: AutomationExtension[] = [
  { name: 'svg.import', description: 'Append editable SVG text or bounded gzip SVGZ base64 through the shared SVG importer. Returns remapped node IDs and compatibility warnings; foreign format conversion is not native-lossless.', mutates: true,
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['svg', 'svgz'] }, content: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string', maxLength: 200 }, pageId: { type: 'string' } }, additionalProperties: false }, execute: importDesignSvg },

  { name: 'vector.export', description: 'Export real editable SVG using existing native geometry and font outlines. Rejects unsupported effects or unsafe resources; never substitutes a fake screenshot.', mutates: false,
    inputSchema: { type: 'object', properties: { ...SVG_OPTION_SCHEMA, pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, maxNodes: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
    execute: (document, params, context) => exportDesignSvg(document, { ...codeOptions(params, context.pageId), scale: params.scale as number | undefined, precision: params.precision as number | undefined, compression: params.compression as SvgExportOptions['compression'], textMode: params.textMode as SvgExportOptions['textMode'], fontMode: params.fontMode as SvgExportOptions['fontMode'], fontEmbeddingAllowed: params.fontEmbeddingAllowed as boolean | undefined }) },
  { name: 'document.import', description: 'Atomically append a validated fd binary or native-json document through the existing importer. Preserves destination identity and remaps nodes, components, tokens, fonts and interactions; returns nodeIdMap. HTML import is unsupported.', mutates: true,
    inputSchema: { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: ['fd', 'native-json'] }, base64: { type: 'string' }, content: { type: 'string' }, document: { type: 'object' }, pageId: { type: 'string' } }, additionalProperties: false },
    execute: importNativeDocument },
  { name: 'code.export', description: 'Deterministic editable HTML/CSS plus stable node-ID map, portable image manifest and explicit fidelity gaps. No scripts are generated.', mutates: false,
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, maxNodes: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
    execute: (document, params, context) => exportDesignCode(document, codeOptions(params, context.pageId)) },
  { name: 'document.export', description: 'Lossless native carrier: format fd uses the existing checksum-protected kernel binfmt codec and returns base64. Default native-json preserves compatibility. Includes nodes, tokens, fonts, components, assets and materials; native transfers capped at 32 MiB including a 64 KiB envelope reserve.', mutates: false,
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['fd', 'native-json'] } }, additionalProperties: false }, execute: (document, params) => params.format === 'fd' ? exportBinaryDocument(document) : exportNativeDocument(document) },
]
