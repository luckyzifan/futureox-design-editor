import { assertDocumentJson } from '../document-capacity'
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
import { stackOrder } from '../layer-order'
import { defaultTextStyle, type DesignDocument, type DesignNode, type Effect, type Paint, type TextCase, type TextRun, type TextStyle } from '../model'
import { AutomationError, type AutomationExtension, type AutomationContext } from './types'
import {
  assetReference, boundedInteger, collectAssetReferences, contextEntries, contextOptions,
  safeWebUrl, type AssetReference, type ContextOptions, type DesignAutomationWarning,
} from './context'
import { createScssColorSession } from './scss-export'
import { cssLinearGradient, cssRadialGradient } from './css-gradient'

export type CodeExportOptions = Pick<ContextOptions, 'pageId' | 'nodeIds'> & { maxNodes?: number; syntax?: 'css' | 'scss' }
export type CodeAsset = AssetReference & { path: string; emitted: boolean; dataUrl?: string }
export const EXPORT_LIMITS = Object.freeze({ nodes: 500, bytes: 8 * 1024 * 1024, nativeBytes: 32 * 1024 * 1024 - 64 * 1024, embeddedAsset: 256 * 1024, embeddedTotal: 2 * 1024 * 1024, previewPixels: 16 * 1024 * 1024 })
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const cssString = (value: string) => `"${Array.from(value, char => /^[a-z\d _-]$/i.test(char) ? char : `\\${char.codePointAt(0)!.toString(16)} `).join('')}"`
const number = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new AutomationError('invalid_params', 'Export contains invalid geometry')
  return String(Math.round(value * 1e6) / 1e6)
}
const px = (value: number) => `${number(value)}px`
const TRANSPARENT_GRADIENT = 'linear-gradient(transparent,transparent)'
// True in the engines that fade a single background layer; false in Firefox.
const CROSS_FADE = 'background-image:-webkit-cross-fade(url(a.png),url(b.png),0%)'
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
  // FD wire framing remains bounded; expanded authored data uses the same
  // resource allowance as the editor, not the MCP packet byte ceiling.
  assertDocumentJson(JSON.stringify(value))
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
  if (params.syntax !== undefined && params.syntax !== 'css' && params.syntax !== 'scss') throw new AutomationError('invalid_params', 'syntax must be css or scss')
  return { pageId: options.pageId, nodeIds: options.nodeIds, maxNodes: boundedInteger(params.maxNodes, 200, 1, EXPORT_LIMITS.nodes, 'maxNodes'), ...(params.syntax === 'scss' ? { syntax: 'scss' as const } : {}) }
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
  const textTransformCss = (textCase: TextCase) => `text-transform:${{ original: 'none', upper: 'uppercase', lower: 'lowercase', title: 'capitalize' }[textCase]}`
  const textTransform = (textCase: TextCase, nodeId: string) => {
    if (textCase === 'title')
      warn('TEXT_CASE_APPROXIMATION', 'Browser capitalization may preserve uppercase letters that the native title case lowers.', nodeId)
    return textTransformCss(textCase)
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
  const rules: { css: string; scss: string; nodeId?: string }[] = []
  const pushRule = (css: string, scss = css, nodeId?: string) => rules.push({ css, scss, nodeId })
  for (const rule of ['*{box-sizing:border-box}', 'html,body{margin:0;padding:0}', '.design-scene{position:relative;isolation:isolate}', '.design-node{position:absolute;left:0;top:0;transform-origin:0 0}', '.design-text{margin:0;white-space:pre-wrap;overflow-wrap:normal}']) pushRule(rule)
  const included = new Set(entries.map(e => e.node.id))
  const safeColor = (value: string, nodeId: string) => {
    const safe = cssColor(value)
    if (!safe) warn('UNSUPPORTED_COLOR', 'Unrecognized color syntax was omitted for safe CSS export.', nodeId)
    return safe
  }
  const paintOpacityColor = (color: string, opacity: number, percent?: string) => {
    const alpha = Math.max(0, Math.min(1, opacity))
    return alpha === 1 ? color : `color-mix(in srgb, ${color} ${percent ?? `${number(alpha * 100)}%`}, transparent)`
  }
  const scssSession = options.syntax === 'scss' ? createScssColorSession(resolved, cssColor, {
    colorMismatch: () => warn('SCSS_COLOR_MISMATCH', 'A bound fill color did not match its resolved variable, so that declaration stayed a CSS literal.'),
    numberMismatch: () => warn('SCSS_NUMBER_MISMATCH', 'A bound number did not match its resolved variable, so that declaration stayed a CSS literal.'),
  }, number) : undefined
  const opacityPercent = (nodeId: string, opacityPath: string | undefined, opacity: number, inverse = false) => {
    const alpha = Math.max(0, Math.min(1, opacity))
    if (!scssSession || !opacityPath || alpha === 1) return undefined
    const literal = `${number((inverse ? 1 - alpha : alpha) * 100)}%`
    const token = scssSession.number(resolved.nodes[nodeId], opacityPath, opacity, inverse ? 'inverse-percent' : 'percent', literal)
    return token === literal ? undefined : token
  }
  const paintCss = (paint: Paint, nodeId: string, width: number, height: number, colorPath?: string): { css?: string; scss?: string; prefixed?: string; prefixedScss?: string; fade?: { opacity: string; opacityScss?: string } } => {
    if (paint.blend !== 'normal' || paint.opacity !== 1) warn('PAINT_COMPOSITING', 'Per-paint blend and opacity may differ from the native compositor.', nodeId)
    const pair = (css?: string, scss = css) => ({ css, scss })
    const opacityPath = colorPath?.endsWith('.color') ? `${colorPath.slice(0, -'color'.length)}opacity` : undefined
    const fillIndex = colorPath?.startsWith('fills.') ? Number(colorPath.split('.')[1]) : undefined
    const percent = paint.kind === 'image' ? undefined : opacityPercent(nodeId, opacityPath, paint.opacity)
    if (paint.kind === 'solid') {
      const color = safeColor(paint.color, nodeId)
      if (!color) return {}
      let token = color
      if (scssSession && colorPath) {
        const bound = scssSession.color(resolved.nodes[nodeId], colorPath, color)
        token = bound !== color ? bound : fillIndex !== undefined && Number.isInteger(fillIndex) ? scssSession.fillColor(resolved.nodes[nodeId], fillIndex, color) ?? color : color
      }
      return pair(paintOpacityColor(color, paint.opacity), paintOpacityColor(token, paint.opacity, percent))
    }
    if (paint.kind === 'image') {
      const asset = paint.image && assetsById.get(assetReference(paint.image, nodeId, paint.id, assetIdentities).id)
      if (paint.transform || paint.tile || paint.adjust) warn('IMAGE_TRANSFORM', 'Image transforms, pattern tiling and color adjustments are not reproduced by CSS background sizing.', nodeId)
      const uri = asset && (asset.dataUrl ?? asset.uri)
      if (!uri || paint.opacity <= 0) return {}
      const url = `url(${cssString(uri)})`
      const alpha = Math.max(0, Math.min(1, paint.opacity))
      if (alpha === 1) return pair(url)
      // Only Chromium and WebKit fade one background layer, and only through
      // the prefixed three-argument cross-fade, whose percentage weights the
      // second image. A gradient stands in for transparency because neither
      // accepts a colour there. Other engines get the plain image on a box of
      // its own, so the url and the opacity travel with the layer.
      const toward = opacityPercent(nodeId, opacityPath, paint.opacity, true)
      const keep = opacityPercent(nodeId, opacityPath, paint.opacity)
      return {
        css: url, scss: url,
        prefixed: `-webkit-cross-fade(${url},${TRANSPARENT_GRADIENT},${number((1 - alpha) * 100)}%)`,
        prefixedScss: toward && `-webkit-cross-fade(${url},${TRANSPARENT_GRADIENT},${toward})`,
        fade: { opacity: `${number(alpha * 100)}%`, opacityScss: keep },
      }
    }
    if (paint.kind === 'linear' || paint.kind === 'radial') {
      if (paint.stops.length > 64) { warn('GRADIENT_LIMIT', 'Gradient with more than 64 stops was omitted.', nodeId); return {} }
      warn('GRADIENT_APPROXIMATION', 'CSS gradient coordinates and interpolation can differ from native rendering.', nodeId)
      const stopsFor = (percentToken?: string) => paint.stops.flatMap(stop => {
        const color = safeColor(stop.color, nodeId)
        return color ? [{ offset: stop.offset, color: paintOpacityColor(color, paint.opacity, percentToken) }] : []
      })
      const stops = stopsFor()
      if (!stops.length) return {}
      const css = paint.kind === 'linear'
        ? cssLinearGradient(width, height, paint.angle, paint.transform, stops)
        : cssRadialGradient(stops, paint.transform)
      if (!css) {
        if (paint.kind === 'radial' && paint.transform) warn('RADIAL_TRANSFORM', 'This radial transform cannot be written as an axis-aligned CSS ellipse, so the fill was omitted instead of a centered gradient.', nodeId)
        return {}
      }
      if (!percent) return pair(css)
      const scssStops = stopsFor(percent)
      const scss = paint.kind === 'linear'
        ? cssLinearGradient(width, height, paint.angle, paint.transform, scssStops)
        : cssRadialGradient(scssStops, paint.transform)
      return pair(css, scss ?? css)
    }
    warn('UNSUPPORTED_GRADIENT', `${paint.kind} gradients are not supported in semantic HTML export.`, nodeId)
    return {}
  }
  const align: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', 'unsafe-center': 'unsafe center', 'unsafe-end': 'unsafe end', stretch: 'stretch', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' }
  const reversesFlex = (layout: DesignNode['layout']) =>
    (layout?.mode === 'horizontal' || layout?.mode === 'vertical') && stackOrder(layout) === 'first-on-top'
  const rootSet = new Set(roots)
  // Keep selected roots in their authored parent coordinate system. Different
  // parents require world composition, so explicitly report this limitation.
  if (new Set(entries.filter(e => rootSet.has(e.node.id)).map(e => e.parentId)).size > 1)
    warn('MULTIPLE_PARENT_SPACES', 'Selected roots have different parent spaces; each root keeps its local transform. Export a common ancestor for a spatially aligned composition.')
  const effectDeclarations = (effects: Effect[], nodeId: string, emitWarnings: boolean) => {
    const shadows: string[] = [], filters: string[] = [], backdrop: string[] = []
    for (const effect of effects.filter(item => item.visible)) {
      if (effect.kind === 'shadow' || effect.kind === 'inner-shadow') {
        const color = safeColor(effect.color, nodeId)
        if (color) shadows.push(`${effect.kind === 'inner-shadow' ? 'inset ' : ''}${px(effect.x)} ${px(effect.y)} ${px(effect.radius)} ${px(effect.spread)} color-mix(in srgb, ${color} ${number(effect.opacity * 100)}%, transparent)`)
        if (emitWarnings) warn('EFFECT_APPROXIMATION', 'Browser CSS shadow and blur kernels differ from the native compositor.', nodeId)
      } else if ((effect.kind === 'blur' || effect.kind === 'gaussian-blur' || effect.kind === 'background-blur') && !effect.gradientBlur) {
        ;(effect.kind === 'background-blur' ? backdrop : filters).push(`blur(${px(effect.radius)})`)
        if (emitWarnings) warn('EFFECT_APPROXIMATION', 'Browser CSS shadow and blur kernels differ from the native compositor.', nodeId)
      } else if (emitWarnings) warn('UNSUPPORTED_EFFECT', `${effect.kind}${effect.gradientBlur ? ' with gradient blur' : ''} is omitted; native material parameters remain in semantic context and canonical export.`, nodeId)
    }
    const decls: string[] = []
    if (shadows.length) decls.push(`box-shadow:${shadows.join(',')}`)
    if (filters.length) decls.push(`filter:${filters.join(' ')}`)
    if (backdrop.length) decls.push(`backdrop-filter:${backdrop.join(' ')}`)
    return decls
  }
  const textParts = (node: DesignNode | undefined, style: TextStyle | undefined, fontSize: number | undefined, bindNumbers: boolean) => {
    const parts: { css: string; scss: string }[] = []
    const token = (path: string, value: number, unit: 'px' | 'none', cssValue: string) =>
      scssSession && node && bindNumbers ? scssSession.number(node, path, value, unit, cssValue) : cssValue
    if (fontSize !== undefined) {
      const cssValue = px(fontSize)
      parts.push({ css: `font-size:${cssValue}`, scss: `font-size:${token('fontSize', fontSize, 'px', cssValue)}` })
    }
    const font = style?.fontId ? document.fonts?.[style.fontId] : undefined
    const family = `font-family:${font ? `${cssString(font.family)},sans-serif` : 'sans-serif'}`
    parts.push({ css: family, scss: family })
    const weight = number(style?.weight ?? 400)
    parts.push({ css: `font-weight:${weight}`, scss: `font-weight:${token('textStyle.weight', style?.weight ?? 400, 'none', weight)}` })
    const line = number(style?.lineHeight ?? 1.35)
    parts.push({ css: `line-height:${line}`, scss: `line-height:${token('textStyle.lineHeight', style?.lineHeight ?? 1.35, 'none', line)}` })
    const spacing = px(style?.letterSpacing ?? 0)
    parts.push({ css: `letter-spacing:${spacing}`, scss: `letter-spacing:${token('textStyle.letterSpacing', style?.letterSpacing ?? 0, 'px', spacing)}` })
    parts.push({ css: `text-align:${style?.align ?? 'start'}`, scss: `text-align:${style?.align ?? 'start'}` })
    const white = `white-space:${style?.wrap ? 'pre-wrap' : 'pre'}`
    parts.push({ css: white, scss: white })
    if (style?.direction && style.direction !== 'auto') parts.push({ css: `direction:${style.direction}`, scss: `direction:${style.direction}` })
    if (style?.writingMode === 'vertical') parts.push({ css: 'writing-mode:vertical-rl', scss: 'writing-mode:vertical-rl' })
    if (style?.textCase && style.textCase !== 'original') {
      const transform = bindNumbers && node ? textTransform(style.textCase, node.id) : textTransformCss(style.textCase)
      parts.push({ css: transform, scss: transform })
    }
    return parts
  }
  let right = 1, bottom = 1
  const strokeRules: { css: string; scss: string }[] = []
  const supportRules: { css: string; scss: string }[] = []
  const fallbackFillMarkup = new Map<string, string>()
  for (const [index, { node, parentId }] of entries.entries()) {
    const n = node, selector = nodeIdMap[n.id].selector, declarations: string[] = [], scssDeclarations: string[] = []
    const decl = (...css: string[]) => { declarations.push(...css); if (scssSession) scssDeclarations.push(...css) }
    const declPair = (css: string, scss: string) => { declarations.push(css); if (scssSession) scssDeclarations.push(scss) }
    const parent = parentId && !rootSet.has(n.id) ? resolved.nodes[parentId] : undefined
    const flow = !!parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute
    const parentWrapsInReverse = parent?.layout?.wrap && reversesFlex(parent.layout)
    const lengthToken = (path: string, value: number, unit: 'px' | 'none') => {
      const cssValue = unit === 'px' ? px(value) : number(value)
      return scssSession ? scssSession.number(n, path, value, unit, cssValue) : cssValue
    }
    declPair(`width:${px(n.width)}`, `width:${lengthToken('width', n.width, 'px')}`)
    declPair(`height:${px(n.height)}`, `height:${lengthToken('height', n.height, 'px')}`)
    declPair(`opacity:${number(n.opacity)}`, `opacity:${lengthToken('opacity', n.opacity, 'none')}`)
    if (!n.visible || n.kind === 'slice') decl('display:none')
    if (scssSession && n.bindings?.visible) scssSession.boolean(n, 'visible')
    const matrix = [...n.transform]
    if (flow) {
      decl('position:relative', 'flex-shrink:0')
      if (parentWrapsInReverse) decl(`order:${-index}`)
      matrix[4] = 0; matrix[5] = 0
      if (n.sizing?.width === 'fill' && parent!.layout!.mode === 'horizontal') decl('flex:1 1 0', 'min-width:0')
      if (n.sizing?.height === 'fill' && parent!.layout!.mode === 'vertical') decl('flex:1 1 0', 'min-height:0')
      if (n.sizing?.alignSelf) decl(`align-self:${align[n.sizing.alignSelf]}`)
      if (parent!.layout!.mode === 'grid') decl(`grid-column:span ${number(n.sizing?.columnSpan ?? 1)}`, `grid-row:span ${number(n.sizing?.rowSpan ?? 1)}`)
    }
    // Flex order changes paint order too. Keep the authored order across all
    // direct children, including the absolute children that skip flex layout.
    if (parentWrapsInReverse) decl(`z-index:${index}`)
    decl(`transform:matrix(${matrix.map(number).join(',')})`)
    if (rootSet.has(n.id)) { right = Math.max(right, n.transform[4] + n.width); bottom = Math.max(bottom, n.transform[5] + n.height) }
    if (n.clip) decl('overflow:hidden')
    if (n.blend !== 'normal' && n.blend !== 'pass-through') {
      if (['linear-burn', 'linear-dodge'].includes(n.blend)) warn('UNSUPPORTED_BLEND', `${n.blend} blend is omitted.`, n.id)
      else decl(`mix-blend-mode:${n.blend}`)
    }
    if (n.blend === 'pass-through') warn('PASS_THROUGH_COMPOSITING', 'Pass-through group compositing is approximated by DOM stacking.', n.id)
    if (n.mask || n.booleanOperation) warn('MASK_OR_BOOLEAN', 'Mask and boolean geometry is not reproduced; the source graph is retained in native export.', n.id)
    if (n.smoothing) warn('CORNER_SMOOTHING', 'Continuous corner smoothing is approximated by CSS border-radius.', n.id)
    if (n.kind === 'ellipse') decl('border-radius:50%')
    else declPair(`border-radius:${n.radii.map(px).join(' ')}`, `border-radius:${n.radii.map((radius, index) => lengthToken(`radii.${index}`, radius, 'px')).join(' ')}`)
    if (n.repeat) warn('REPEAT_TRANSFORMS_NOT_EXPORTED', 'Semantic HTML includes only the editable source, not its derived repeat appearances. Use native FD/JSON to preserve the repeat, or PNG/SVG/PDF for visual output.', n.id)
    if (n.arc || n.textPath || n.pathOffset || n.vectorBrush) warn('SPECIAL_GEOMETRY', 'Arc, text-on-path, path-offset and vector-brush geometry is not reproduced in HTML.', n.id)
    const strokes = n.strokes.filter(s => s.visible && s.paint.visible)
    const stroke = strokes[0]
    const strokeOutline = stroke?.paint.kind === 'solid' && (stroke.align === 'center' || stroke.align === 'outside')
    if (['vector', 'polygon', 'star', 'line'].includes(n.kind)) {
      warn('UNSUPPORTED_SHAPE', `${n.kind} geometry uses a bounding-box placeholder; use native SVG/image export for its exact shape.`, n.id)
      if (!strokeOutline) decl('outline:1px dashed #999')
    }
    const fills = n.fills.map((paint, index) => ({ paint, index })).filter(item => item.paint.visible).slice(0, 16)
    if (n.fills.length > 16) warn('PAINT_LIMIT', 'Only the first 16 visible fills are exported.', n.id)
    if (n.kind === 'text') {
      const color = fills.find(item => item.paint.kind === 'solid')
      if (color) {
        const safe = paintCss(color.paint, n.id, n.width, n.height, `fills.${color.index}.color`)
        if (safe.css) declPair(`color:${safe.css}`, `color:${safe.scss ?? safe.css}`)
      }
      if (fills.length > 1 || fills.some(item => item.paint.kind !== 'solid')) warn('TEXT_PAINTS', 'Text export uses one solid fill; additional text paints are omitted.', n.id)
    } else {
      const layers = fills.flatMap(item => {
        const value = paintCss(item.paint, n.id, n.width, n.height, `fills.${item.index}.color`)
        if (!value.css) return []
        const wrap = (color: string) => item.paint.kind === 'solid' ? `linear-gradient(${color},${color})` : color
        const size = item.paint.kind === 'image'
          ? item.paint.fit === 'stretch' ? '100% 100%' : item.paint.fit
          : 'auto'
        return [{ css: wrap(value.css), scss: wrap(value.scss ?? value.css), size, prefixed: value.prefixed, prefixedScss: value.prefixedScss, fade: value.fade }]
      })
      if (layers.length) {
        layers.reverse()
        if (!layers.some(item => item.fade)) {
          declPair(`background-image:${layers.map(item => item.css).join(',')}`, `background-image:${layers.map(item => item.scss).join(',')}`)
        } else {
          type Layer = typeof layers[number]
          const listing = (items: Layer[], pick: (item: Layer) => string) => [
            `background-image:${items.map(pick).join(',')}`,
            ...(items.some(item => item.size !== 'auto') ? [`background-size:${items.map(item => item.size).join(',')}`, 'background-position:center', 'background-repeat:no-repeat'] : []),
          ].join(';')
          const exactCss = listing(layers, item => item.prefixed ?? item.css)
          const exactScss = listing(layers, item => item.prefixedScss ?? item.prefixed ?? item.scss)
          // Each transformed node is a stacking context. Absolutely positioned
          // fill boxes paint from bottom to top below the stroke and children.
          const fallback = layers.slice().reverse().map((item, index) => {
            const className = `${nodeIdMap[n.id].elementId}-fill-${index}`
            const opacity = item.fade ? `;opacity:${item.fade.opacity}` : ''
            const opacityScss = item.fade ? `;opacity:${item.fade.opacityScss ?? item.fade.opacity}` : ''
            return {
              markup: `<span class="design-fallback-fill ${className}" aria-hidden="true"></span>`,
              css: `.${className}{${listing([item], layer => layer.css)}${opacity}}`,
              scss: `.${className}{${listing([item], layer => layer.scss)}${opacityScss}}`,
            }
          })
          fallbackFillMarkup.set(n.id, fallback.map(item => item.markup).join(''))
          supportRules.push(
            { css: `@supports (${CROSS_FADE}){${selector}{${exactCss}}}`, scss: `@supports (${CROSS_FADE}){${selector}{${exactScss}}}` },
            { css: `@supports not (${CROSS_FADE}){${fallback.map(item => item.css).join('')}}`,
              scss: `@supports not (${CROSS_FADE}){${fallback.map(item => item.scss).join('')}}` },
          )
        }
      }
      if (layers.some(layer => layer.size !== 'auto') && !layers.some(layer => layer.fade)) {
        decl(`background-size:${layers.map(layer => layer.size).join(',')}`, 'background-position:center', 'background-repeat:no-repeat')
      }
    }
    if (stroke?.paint.kind === 'solid') {
      const color = paintCss(stroke.paint, n.id, n.width, n.height)
      if (color.css) {
        const strokeIndex = n.strokes.indexOf(stroke)
        const widthCss = px(stroke.width)
        const widthScss = lengthToken(`strokes.${strokeIndex}.width`, stroke.width, 'px')
        const token = color.scss ?? color.css
        if (stroke.align === 'outside') {
          declPair(`outline:${widthCss} solid ${color.css}`, `outline:${widthScss} solid ${token}`)
        } else {
          const centered = stroke.align === 'center'
          const innerCss = centered ? px(stroke.width / 2) : widthCss
          const innerScss = centered ? widthScss === widthCss ? innerCss : `calc(${widthScss} / 2)` : widthScss
          if (centered) declPair(`outline:${innerCss} solid ${color.css}`, `outline:${innerScss} solid ${token}`)
          // A border on the layer itself shifts its children and shrinks its
          // flex content box. Paint the inner stroke on a separate box.
          const pseudo = `${selector}::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none`
          strokeRules.push({ css: `${pseudo};border:${innerCss} solid ${color.css}}`, scss: `${pseudo};border:${innerScss} solid ${token}}` })
        }
      }
    }
    if (strokes.length) warn('STROKE_APPROXIMATION', 'CSS border approximates strokes; alignment, multiple strokes, dashes, joins, markers and width profiles may differ.', n.id)
    const effectCss = effectDeclarations(n.effects, n.id, true)
    let effectScss = effectCss
    if (scssSession && n.styleRefs?.effects) {
      const shared = resolved.designSystem?.styles[n.styleRefs.effects]
      if (shared?.kind === 'effect' && Array.isArray(shared.value)) effectScss = scssSession.effectScss(n.styleRefs.effects, shared.name, effectDeclarations(shared.value as Effect[], n.id, false), effectCss)
    }
    for (const css of effectCss) declarations.push(css)
    if (scssSession) for (const piece of effectScss) scssDeclarations.push(piece)
    if (n.layout && n.layout.mode !== 'none') {
      const l = n.layout
      const reverse = reversesFlex(l)
      if (l.wrap && (l.align === 'unsafe-center' || l.align === 'unsafe-end')) decl('align-content:' + align[l.align])
      else if (l.wrap && reverse) decl('align-content:start')
      const mainValue = l.mode === 'vertical' ? l.gap : l.lineGap
      const crossValue = l.mode === 'vertical' ? l.lineGap : l.gap
      const mainPath = l.mode === 'vertical' ? 'layout.gap' : 'layout.lineGap'
      const crossPath = l.mode === 'vertical' ? 'layout.lineGap' : 'layout.gap'
      const display = `display:${n.visible ? l.mode === 'grid' ? 'grid' : 'flex' : 'none'}`
      decl(display)
      declPair(`padding:${l.padding.map(px).join(' ')}`, `padding:${l.padding.map((value, index) => lengthToken(`layout.padding.${index}`, value, 'px')).join(' ')}`)
      declPair(`gap:${px(mainValue)} ${px(crossValue)}`, `gap:${lengthToken(mainPath, mainValue, 'px')} ${lengthToken(crossPath, crossValue, 'px')}`)
      let justify = align[l.justify]
      if (reverse && !l.wrap) {
        // Rust reverses item order and keeps the original main-axis origin.
        // CSS flex-start and flex-end change sides with flex-direction.
        if (l.justify === 'start' || l.justify === 'stretch') justify = 'start'
        else if (l.justify === 'end') justify = 'safe end'
        else if (l.justify === 'center') justify = 'safe center'
        else if (l.justify === 'space-between' && n.children.filter(id => {
          const child = resolved.nodes[id]
          return included.has(id) && child.visible && child.kind !== 'slice' && !child.sizing?.absolute
        }).length <= 1) justify = 'start'
      }
      decl(`justify-content:${justify}`, `align-items:${align[l.align]}`)
      if (l.mode === 'grid') decl(`grid-template-columns:repeat(${number(l.columns)},minmax(0,1fr))`)
      else {
        const axis = l.mode === 'horizontal' ? 'row' : 'column'
        // Wrapped stacks sort the items before CSS chooses which line they fit.
        decl(`flex-direction:${reverse && !l.wrap ? `${axis}-reverse` : axis}`, `flex-wrap:${l.wrap ? 'wrap' : 'nowrap'}`)
      }
      warn('LAYOUT_APPROXIMATION', 'CSS flex/grid uses resolved dimensions but may size and wrap differently from the design layout engine.', n.id)
    }
    if (n.kind === 'text') {
      const parts = textParts(n, n.textStyle, n.fontSize, true)
      let scssParts = parts.map(part => part.scss)
      if (scssSession && n.styleRefs?.textStyle) {
        const shared = resolved.designSystem?.styles[n.styleRefs.textStyle]
        const value = shared?.kind === 'text' ? shared.value : undefined
        if (shared && value && typeof value === 'object' && !Array.isArray(value)) {
          const styleCss = textParts(undefined, { ...defaultTextStyle(), ...(value as TextStyle) }, undefined, false).map(part => part.css)
          scssParts = scssSession.applyText(n.styleRefs.textStyle, shared.name, styleCss, parts)
        }
      }
      for (const part of parts) declarations.push(part.css)
      if (scssSession) for (const piece of scssParts) scssDeclarations.push(piece)
      warn('FONT_METRICS', 'HTML uses installed browser fonts; embedded font binaries, native shaping, OpenType features and paragraph metrics are not exported.', n.id)
    }
    pushRule(`${selector}{${declarations.join(';')}}`, scssSession ? `${selector}{${scssDeclarations.join(';')}}` : undefined, n.id)
  }
  for (const rule of strokeRules) pushRule(rule.css, rule.scss)
  if (fallbackFillMarkup.size) {
    pushRule('.design-fallback-fill{display:none}')
    pushRule(`@supports not (${CROSS_FADE}){.design-fallback-fill{display:block;position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none}}`)
  }
  for (const rule of supportRules) pushRule(rule.css, rule.scss)
  pushRule(`.design-scene{width:${px(right)};height:${px(bottom)};background:${cssColor(page.background) ?? 'transparent'}}`)
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
      if (run.italic !== undefined) declarations.push(`font-style:${run.italic ? 'italic' : 'normal'}`)
      if (run.weight !== undefined) declarations.push(`font-weight:${number(run.weight)}`)
      if (run.letterSpacing !== undefined) declarations.push(`letter-spacing:${px(run.letterSpacing)}`)
      if (run.lineHeight !== undefined) declarations.push(`line-height:${number(run.lineHeight)}`)
      if (run.fontId && document.fonts?.[run.fontId]) declarations.push(`font-family:${cssString(document.fonts[run.fontId].family)},sans-serif`)
      if (run.underline || run.strikethrough) declarations.push(`text-decoration:${[run.underline && 'underline', run.strikethrough && 'line-through'].filter(Boolean).join(' ')}`)
      if (run.textCase) declarations.push(textTransform(run.textCase, n.id))
      if (declarations.length) pushRule(`.${className}{${declarations.join(';')}}`)
      const text = htmlEscape(n.text.slice(start, end)), link = run.link && safeWebUrl(run.link)
      if (run.link && !link) warn('UNSAFE_LINK', 'A non-HTTP(S) or unsafe text link was omitted; its text remains.', n.id)
      return link ? `<a class="${className}" href="${htmlEscape(link)}" rel="noopener noreferrer">${text}</a>` : `<span class="${className}">${text}</span>`
    }).join('')
  }
  // Post-order assembly avoids recursive calls on arbitrary document objects.
  const markup = new Map<string, string>()
  for (const { node: n } of [...entries].reverse()) {
    const content = (fallbackFillMarkup.get(n.id) ?? '') + (n.kind === 'text' ? renderText(n) : '') + n.children.filter(id => included.has(id)).map(id => markup.get(id) ?? '').join('')
    markup.set(n.id, `<div id="${nodeIdMap[n.id].elementId}" class="design-node${n.kind === 'text' ? ' design-text' : ''}" data-node-id="${htmlEscape(n.id)}" data-node-kind="${htmlEscape(n.kind)}" aria-label="${htmlEscape(n.name)}">${content}</div>`)
  }
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data: https: http:; script-src 'none'; object-src 'none'; base-uri 'none'"><title>${htmlEscape(document.name)}</title><link rel="stylesheet" href="styles.css"></head><body><main class="design-scene">${roots.map(id => markup.get(id) ?? '').join('')}</main></body></html>`
  const css = `${rules.map(rule => rule.css).join('\n')}\n`
  const scssResult = scssSession?.render(rules.map(rule => ({ scss: rule.scss, nodeId: rule.nodeId })), entries)
  if (scssResult) for (const warning of scssResult.warnings) warn(warning.code, warning.message, warning.nodeId)
  const result = { format: 'futureox.design-code.v1', language: 'html-css', html, css, ...(scssResult ? { scss: scssResult.scss } : {}), nodeIdMap, assets, warnings, fidelity: 'approximate', sourceDocumentId: document.id, pageId: page.id }
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

export const PREVIEW_LIMITS = Object.freeze({ pixels: EXPORT_LIMITS.previewPixels, maxSide: 16384, responseBytes: EXPORT_LIMITS.bytes, envelopeBytes: 64 * 1024, nodeIds: 256, minScale: 0.01, maxScale: 4 })
export const PREVIEW_FORMATS = ['png', 'jpeg', 'webp', 'pdf'] as const
type ProductRegionFormat = typeof PREVIEW_FORMATS[number]
export type PreviewOptions = Pick<ContextOptions, 'pageId' | 'nodeIds'> & { format?: ProductRegionFormat; scale?: number; signal?: AbortSignal }
type ProductRegionOptions = Omit<PreviewOptions, 'format'>

/** Actual product CPU raster export, not the displayed GPU canvas or app chrome.
 * Never falls back to SVG/DOM rasterization when the product renderer fails. */
async function renderProductRegion(document: DesignDocument, options: ProductRegionOptions, format: ProductRegionFormat) {
  options.signal?.throwIfAborted()
  const selection = contextEntries(document, { ...options, maxDepth: 0 })
  const scale = options.scale ?? 1
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < PREVIEW_LIMITS.minScale || scale > PREVIEW_LIMITS.maxScale)
    throw new AutomationError('invalid_params', `Preview scale must be between ${PREVIEW_LIMITS.minScale} and ${PREVIEW_LIMITS.maxScale}`)
  if (options.nodeIds && options.nodeIds.length > PREVIEW_LIMITS.nodeIds) throw new AutomationError('invalid_params', 'Preview supports at most 256 node ids')
  const { exportImage, rasterExportBounds } = await import('../export')
  options.signal?.throwIfAborted()
  const prepared = kernelLayout(document)
  const target = options.nodeIds ? { kind: 'selection' as const, nodeIds: selection.roots } : { kind: 'page' as const, padding: 0 }
  const bounds = rasterExportBounds(prepared, selection.page.id, target, format)
  const plannedWidth = Math.ceil(bounds.width * scale), plannedHeight = Math.ceil(bounds.height * scale)
  if (![plannedWidth, plannedHeight].every(Number.isSafeInteger) || plannedWidth > PREVIEW_LIMITS.maxSide || plannedHeight > PREVIEW_LIMITS.maxSide || plannedWidth * plannedHeight > PREVIEW_LIMITS.pixels) throw new AutomationError('preview_limit', 'Preview exceeds 16 megapixels or 16384 pixels per side; select a smaller region or explicit lower scale')
  const { width, height } = kernelExportPlan(bounds, scale)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > PREVIEW_LIMITS.pixels) throw new AutomationError('preview_limit', 'Preview exceeds 16 megapixels; select a smaller region or explicit lower scale')
  if (typeof Worker !== 'function') throw new AutomationError('renderer_unavailable', 'Product CPU export requires the mounted renderer Worker runtime; no substitute image was generated')
  const result = await exportImage(prepared, selection.page.id, format, scale, undefined, options.signal, target)
  options.signal?.throwIfAborted()
  const mime = format === 'pdf' ? 'application/pdf' : `image/${format}`
  if (result.backend !== 'cpu' || result.blob.type !== mime || result.width !== width || result.height !== height) throw new AutomationError('invalid_preview', 'Product export returned inconsistent renderer, media type or dimensions')
  return { selection, target, bounds, scale, width, height, result }
}

/** The plugin bridge returns only the bounded product bytes, including bitmap PDF. */
export async function capturePluginRegion(document: DesignDocument, options: ProductRegionOptions & { format: 'png' | 'jpeg' | 'pdf' }, maxBase64Bytes: number) {
  const { result } = await renderProductRegion(document, options, options.format)
  if (!result.blob.size) throw new AutomationError('invalid_preview', 'Product export did not return bytes')
  if (4 * Math.ceil(result.blob.size / 3) > maxBase64Bytes)
    throw new AutomationError('export_limit', 'Export exceeds the plugin transport. Lower the scale or narrow the selection.')
  const bytes = new Uint8Array(await result.blob.arrayBuffer())
  options.signal?.throwIfAborted()
  return { base64: bytesToBase64(bytes) }
}

export async function captureDesignPreview(document: DesignDocument, options: PreviewOptions = {}) {
  options.signal?.throwIfAborted()
  const format = options.format ?? 'png'
  if (!PREVIEW_FORMATS.includes(format)) throw new AutomationError('invalid_params', 'Preview format must be png, jpeg, webp or pdf')
  const { selection, target, bounds, scale, width, height, result } = await renderProductRegion(document, options, format)
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
    warnings: [{ code: 'CPU_EXPORT_PREVIEW', message: format === 'pdf'
      ? 'Bitmap PDF from the product CPU export. Its embedded raster represents the selected design content.'
      : 'Product CPU raster export of design content. Does not capture app chrome, selection overlays or the displayed GPU canvas; GPU/display pixel equivalence is not asserted.' }] as DesignAutomationWarning[],
  }
  if (new TextEncoder().encode(JSON.stringify(preview)).byteLength > PREVIEW_LIMITS.responseBytes - PREVIEW_LIMITS.envelopeBytes) throw new AutomationError('response_limit', 'Preview metadata and encoded pixels exceed the transport budget; lower scale or narrow the selection')
  options.signal?.throwIfAborted()
  return preview
}

const EMBEDDED_SOURCE_LIMITS = Object.freeze({ images: 20, depth: 64, bytes: EXPORT_LIMITS.bytes - PREVIEW_LIMITS.envelopeBytes })
const imageDataPrefix = /^data:(image\/(?:png|jpeg|gif|webp));base64,/
const validImageBase64 = /^[A-Za-z0-9+/]*={0,2}$/

function matchesImageHeader(mimeType: string, base64: string): boolean {
  try {
    const bytes = atob(base64.slice(0, 16))
    switch (mimeType) {
      case 'image/png': return bytes.startsWith('\x89PNG\r\n\x1a\n')
      case 'image/jpeg': return bytes.startsWith('\xff\xd8\xff')
      case 'image/gif': return bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')
      case 'image/webp': return bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
      default: return false
    }
  } catch { return false }
}

export function exportEmbeddedImages(document: DesignDocument, params: Record<string, unknown>, context: AutomationContext) {
  const nodeIds = params.nodeIds
  if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > EMBEDDED_SOURCE_LIMITS.images ||
      nodeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128))
    throw new AutomationError('invalid_params', 'Choose 1–20 local node IDs')
  const selection = contextEntries(document, { pageId: context.pageId, nodeIds, maxDepth: EMBEDDED_SOURCE_LIMITS.depth })
  const seen = new Set<string>()
  const assets: Array<{ nodeId: string; mimeType: string; base64: string }> = []
  let bytes = 0, rawImagesTruncated = Boolean(selection.omittedByDepth), unavailableImages = 0
  source: for (const { node } of selection.entries) {
    for (const paint of node.fills) {
      if (paint.kind !== 'image' || paint.video || !paint.image || seen.has(paint.image)) continue
      seen.add(paint.image)
      const prefix = imageDataPrefix.exec(paint.image)
      if (!prefix) { unavailableImages++; continue }
      const encodedLength = paint.image.length - prefix[0].length
      if (assets.length >= EMBEDDED_SOURCE_LIMITS.images || bytes + encodedLength > EMBEDDED_SOURCE_LIMITS.bytes) {
        rawImagesTruncated = true
        break source
      }
      const base64 = paint.image.slice(prefix[0].length)
      if (encodedLength % 4 || !validImageBase64.test(base64) || !matchesImageHeader(prefix[1], base64)) {
        unavailableImages++
        continue
      }
      bytes += base64.length
      assets.push({ nodeId: node.id, mimeType: prefix[1], base64 })
    }
  }
  return { format: 'futureox.design-asset-batch.v1', pageId: selection.page.id, assets,
    rawImagesOnly: true, rawImagesTruncated, unavailableImages, urls: false }
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
  { name: 'raster.sourceAssets', description: 'Read exact PNG, JPEG, GIF or WebP image bytes embedded in fills on the requested local subtrees. Up to 20 distinct sources, within the response byte budget. External or invalid image references are reported separately.', mutates: false,
    inputSchema: { type: 'object', required: ['nodeIds'], additionalProperties: false,
      properties: { nodeIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 128 } } } },
    execute: exportEmbeddedImages },
  { name: 'svg.import', description: 'Append editable SVG text or bounded gzip SVGZ base64 through the shared SVG importer. Returns remapped node IDs and compatibility warnings; foreign format conversion is not native-lossless.', mutates: true,
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['svg', 'svgz'] }, content: { type: 'string' }, base64: { type: 'string' }, name: { type: 'string', maxLength: 200 }, pageId: { type: 'string' } }, additionalProperties: false }, execute: importDesignSvg },

  { name: 'vector.export', description: 'Export real editable SVG using existing native geometry and font outlines. Rejects unsupported effects or unsafe resources; never substitutes a fake screenshot.', mutates: false,
    inputSchema: { type: 'object', properties: { ...SVG_OPTION_SCHEMA, pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, maxNodes: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
    execute: (document, params, context) => exportDesignSvg(document, { ...codeOptions(params, context.pageId), scale: params.scale as number | undefined, precision: params.precision as number | undefined, compression: params.compression as SvgExportOptions['compression'], textMode: params.textMode as SvgExportOptions['textMode'], fontMode: params.fontMode as SvgExportOptions['fontMode'], fontEmbeddingAllowed: params.fontEmbeddingAllowed as boolean | undefined }) },
  { name: 'document.import', description: 'Atomically append a validated fd binary or native-json document through the existing importer. Preserves destination identity and remaps nodes, components, tokens, fonts and interactions; returns nodeIdMap. HTML import is unsupported.', mutates: true,
    inputSchema: { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: ['fd', 'native-json'] }, base64: { type: 'string' }, content: { type: 'string' }, document: { type: 'object' }, pageId: { type: 'string' } }, additionalProperties: false },
    execute: importNativeDocument },
  { name: 'code.export', description: 'Deterministic editable HTML/CSS plus stable node-ID map, portable image manifest and explicit fidelity gaps. No scripts are generated. syntax scss also returns selection-scoped Sass for bound values, unused variable modes, solid fill styles, text and effect mixins, and @at-root nesting. The css field stays the flat stylesheet.', mutates: false,
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 500 }, maxNodes: { type: 'integer', minimum: 1, maximum: 500 }, syntax: { type: 'string', enum: ['css', 'scss'] } }, additionalProperties: false },
    execute: (document, params, context) => exportDesignCode(document, codeOptions(params, context.pageId)) },
  { name: 'document.export', description: 'Lossless native carrier: format fd uses the existing checksum-protected kernel binfmt codec and returns base64. Default native-json preserves compatibility. Includes nodes, tokens, fonts, components, assets and materials; native transfers capped at 32 MiB including a 64 KiB envelope reserve.', mutates: false,
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['fd', 'native-json'] } }, additionalProperties: false }, execute: (document, params) => params.format === 'fd' ? exportBinaryDocument(document) : exportNativeDocument(document) },
]
