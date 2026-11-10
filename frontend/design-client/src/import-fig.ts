import { decode_fig_network_json, decode_fig_rounded_network_json, decode_fig_fill_commands_json, network_geometry_json, fig_mask_suffixes, fig_stroke_caps_json } from './generated/design-kernel/design_kernel'
import { assertImportInputBytes } from './import-input-policy'
import { figArchive, inflateFigDeflate } from './import-fig-archive'
export { figArchive } from './import-fig-archive'
import { preflightFigZstd } from './import-fig-zstd'
import { boundedImportWarnings } from './import-warnings'
import { Decompress } from 'fzstd'
import { ByteBuffer, decodeBinarySchema, type Definition, type Schema } from 'kiwi-schema'
import {
  blank,
  node,
  paint,
  stroke,
  effect,
  uid,
  defaultTextStyle,
  defaultLayout,
  defaultSizing,
  hasStrokeMarkers,
  hasLayerExports,
  hasLocalTools,
  hasSchema20Features,
  type DesignNode,
  type Matrix,
  type Paint,
  type StrokeMarker,
  type Network,
  type Stroke,
  type Effect,
} from './model'
import type { ImportedDesign } from './import-svg'
import { emptySystem } from './design-system'
import { importFigTextExtras, importFigTextRuns } from './import-fig-text'
import { applyFigFacet, assertFigStructure, figNodeKind, figNote, importFigPrototype, parkFigReceipts, type FigReceipts } from './import-fig-nodes'
import { defaultColorSettings } from './color'
import { figImageAdjust } from './import-fig-image'
import { importFigComponents } from './import-fig-components'
import { applyFigDocumentSemantics, figGuides, importFigVariableNodes, includeFigRecord, storeFigVariables } from './import-fig-document'
import { inverse } from './commands/affine'

const MAX = 64 * 1024 * 1024
function collector(limit = MAX, compressedLength?: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  return {
    push: (x: Uint8Array) => {
      size += x.length
      if (size > limit) throw new Error('导入解压数据超限')
      if (compressedLength !== undefined && size > 4096 && size > compressedLength * 200)
        throw new Error('FIG 分段展开比例超过 200')
      chunks.push(x)
    },
    bytes: () => {
      const out = new Uint8Array(size)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    },
  }
}
function inflate(bytes: Uint8Array, limit = MAX) {
  const c = collector(limit, bytes.length),
    zstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
  if (bytes[0] >= 0x50 && bytes[0] <= 0x5f && bytes[1] === 0x2a && bytes[2] === 0x4d && bytes[3] === 0x18)
    throw new Error('FIG Zstd 不支持跳过帧')
  const declared = zstd ? preflightFigZstd(bytes, limit) : undefined
  if (declared !== undefined && declared > 4096 && declared > bytes.length * 200)
    throw new Error('FIG 分段声明展开比例超过 200')
  if (zstd) {
    const stream = new Decompress(c.push)
    for (let i = 0; i < bytes.length; i += 1024)
      stream.push(bytes.subarray(i, i + 1024), i + 1024 >= bytes.length)
  } else inflateFigDeflate(bytes, limit, c.push)
  const output = c.bytes()
  if (declared !== undefined && output.length !== declared) throw new Error('Zstd 内容长度不符')
  return output
}
/** One complete value. The ceiling stays 2_000_000; a large file continues in
 * another segment instead of raising this untrusted read budget. */
const FIG_SEGMENT_WORK = 2_000_000
const FIG_MAX_DEPTH = 128
class FigDecodeBudgetError extends Error {
  constructor(readonly reason: 'work' | 'depth') {
    super('FIG 解码预算超限')
  }
}
const workBudget = (error: unknown): error is FigDecodeBudgetError =>
  error instanceof FigDecodeBudgetError && error.reason === 'work'

/** Interpret the embedded schema. Imported names are data, never generated JS.
 * Message fields and message-array elements are segment boundaries. A value
 * that crosses the segment restarts alone; a value that still does not fit
 * rejects. Struct fields stay in one segment. Byte arrays are payload, not
 * one read per byte. The same rules are enforced by the native kiwi reader. */
export function decodeKiwi(schema: Schema, bytes: Uint8Array): Record<string, any> {
  if (schema.definitions.length > 4096) throw new Error('FIG schema 过大')
  const defs = new Map(schema.definitions.map((d) => [d.name, d]))
  if (defs.size !== schema.definitions.length) throw new Error('FIG schema 类型名称重复')
  const bb = new ByteBuffer(bytes)
  const cursor = bb as ByteBuffer & { _index: number }
  if (!Number.isInteger(cursor._index)) throw new Error('FIG 解码游标不可用')
  let work = 0
  const valueAt = (f: Definition['fields'][number], depth: number): any => {
    if (!f.type) throw new Error('FIG 字段缺少类型')
    if (!f.isArray) return read(f.type, depth + 1)
    const count = bb.readVarUint()
    if (count > MAX || (f.type !== 'byte' && count > 200000)) throw new Error('FIG 数组过大')
    if (f.type === 'byte') {
      const out = new Uint8Array(count)
      for (let i = 0; i < count; i++) out[i] = bb.readByte()
      return out
    }
    const message = defs.get(f.type)?.kind === 'MESSAGE'
    const items = new Array(count)
    for (let i = 0; i < count; i++) {
      if (!message) {
        items[i] = read(f.type, depth + 1)
        continue
      }
      const at = cursor._index
      const spent = work
      try {
        items[i] = read(f.type, depth + 1)
      } catch (error) {
        if (!workBudget(error) || spent === 0) throw error
        cursor._index = at
        work = 0
        items[i] = read(f.type, depth + 1)
      }
    }
    return items
  }
  const read = (type: string, depth: number): any => {
    if (depth > FIG_MAX_DEPTH) throw new FigDecodeBudgetError('depth')
    if (++work > FIG_SEGMENT_WORK) throw new FigDecodeBudgetError('work')
    switch (type) {
      case 'bool':
        return !!bb.readByte()
      case 'byte':
        return bb.readByte()
      case 'int':
        return bb.readVarInt()
      case 'uint':
        return bb.readVarUint()
      case 'float':
        return bb.readVarFloat()
      case 'string':
        return bb.readString()
      case 'uint64':
        return bb.readVarUint64().toString()
      case 'int64':
        return bb.readVarInt64().toString()
    }
    const d = defs.get(type)
    if (!d) throw new Error(`未知 FIG 类型 ${type}`)
    if (d.kind === 'ENUM') {
      const value = bb.readVarUint()
      return d.fields.find((f) => f.value === value)?.name ?? value
    }
    const result: Record<string, any> = Object.create(null)
    const assign = (f: Definition['fields'][number]) => {
      result[f.name] = valueAt(f, depth)
    }
    if (d.kind === 'STRUCT') {
      for (const f of d.fields) assign(f)
      return result
    }
    const byId = new Map(d.fields.map((f) => [f.value, f]))
    for (;;) {
      const at = cursor._index
      const spent = work
      const tag = bb.readVarUint()
      if (tag === 0) break
      const f = byId.get(tag)
      if (!f) throw new Error(`FIG schema 缺少字段 ${tag}`)
      try {
        assign(f)
      } catch (error) {
        if (!workBudget(error) || spent === 0) throw error
        cursor._index = at
        work = 0
        if (bb.readVarUint() !== tag) throw new Error(`FIG schema 缺少字段 ${tag}`)
        assign(f)
      }
    }
    return result
  }
  return read('Message', 0)
}
export function decodeFig(bytes: Uint8Array) {
  assertImportInputBytes(bytes.length)
  const files = figArchive(bytes),
    canvas = files['canvas.fig']
  if (new TextDecoder().decode(canvas.subarray(0, 8)) !== 'fig-kiwi' || canvas.length < 20)
    throw new Error('不支持的 FIG 文件头')
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength)
  let offset = 12
  const parts: Uint8Array[] = []
  for (let i = 0; i < 2; i++) {
    if (offset + 4 > canvas.length) throw new Error('FIG 分段长度缺失')
    const length = view.getUint32(offset, true)
    offset += 4
    if (!length || offset + length > canvas.length) throw new Error('FIG 分段长度无效')
    parts.push(canvas.subarray(offset, offset + length))
    offset += length
  }
  if (offset !== canvas.length) throw new Error('FIG 分段存在尾随数据')
  const schema = inflate(parts[0], 4 * 1024 * 1024)
  const data = inflate(parts[1], MAX)
  return { data: decodeKiwi(decodeBinarySchema(schema), data), files }
}
const guid = (g: any) => (typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : '')
type FigColorSpace = 'srgb' | 'display-p3'
const rgb = (c: any, space: FigColorSpace) => {
  const values = ['r','g','b'].map(k=>c?.[k] ?? 0)
  if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('FIG 颜色数值无效')
  if(space==='srgb' && values.every(v=>v>=0&&v<=1&&Math.round(v*255)/255===v))
    return '#'+values.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('')
  return `color(${space} ${values.join(' ')} / 1)`
}
// Figma keeps alpha on each stop's Color, independently of paint opacity.
// Use the same portable straight-RGBA representation as the Sketch codec.
const gradientStopColor = (c: any, space: FigColorSpace) => {
  const alpha = c?.a ?? 1
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
    throw new Error('FIG 渐变色标透明度无效')
  if (alpha === 1) return rgb(c, space)
  const components = ['r', 'g', 'b'].map(k => c?.[k] ?? 0)
  if (components.some(v => !Number.isFinite(v) || v < 0 || v > 1))
    throw new Error('FIG 渐变色标颜色无效')
  return `color(${space} ${components.join(' ')} / ${alpha})`
}
const matrix = (m: any): Matrix =>
  m ? [m.m00, m.m10, m.m01, m.m11, m.m02, m.m12] : [1, 0, 0, 1, 0, 0]
const bytesData = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}
function vectorBlob(bytes: Uint8Array, sx: number, sy: number, warnings: {add(message:string):unknown},record:any): Pick<DesignNode,'network'|'vectorGeometry'> & { strokeCap?: string; strokeJoin?: string } {
  const rounded=record.cornerRadius>0||record.vectorData?.styleOverrideTable!==undefined
  const decoded=JSON.parse(rounded?decode_fig_rounded_network_json(bytes,sx,sy,record.cornerRadius??0,record.cornerSmoothing??0,JSON.stringify(record.vectorData?.styleOverrideTable??null)):decode_fig_network_json(bytes,sx,sy)) as Pick<DesignNode,'network'|'vectorGeometry'>&{vertexStyles:number[];regionStyles:number[];cornersApplied?:boolean;strokeCap?:string;strokeJoin?:string}
  if(rounded&&!decoded.cornersApplied)warnings.add('FIG 矢量圆角包含尚不支持的轮廓、平滑或样式覆盖；源样式需要核对')
  if(decoded.vertexStyles.some(id=>id!==0)||decoded.regionStyles.some(id=>id!==0))warnings.add('FIG 矢量包含独立顶点或区域样式；几何与区域引用已保留，样式覆盖需要核对')
  return {
    ...(decoded.network?{network:decoded.network}:{}),
    ...(decoded.vectorGeometry?{vectorGeometry:decoded.vectorGeometry}:{}),
    ...(decoded.strokeCap?{strokeCap:decoded.strokeCap as string}:{}),
    ...(decoded.strokeJoin?{strokeJoin:decoded.strokeJoin as string}:{}),
  }
}

/** The field names and enum values here come from the embedded native FIG schema,
 * not the REST/plugin API. Keep unsupported layout semantics explicit: silently
 * treating GRID, baseline alignment or weighted growth as a vertical stack loses
 * both the imported appearance and subsequent editing behavior. */
type FigLayoutRecord = Record<string, unknown> & {
  stackMode?: string
  stackChildPrimaryGrow?: number
  size?: { x: number; y: number }
  minSize?: { value?: { x: number; y: number } }
  maxSize?: { value?: { x: number; y: number } }
}
function importLayout(n: DesignNode, r: FigLayoutRecord, parent: FigLayoutRecord | undefined, reverseZ: Set<string>, note?: (message: string) => void) {
  const unsupported = (field: string, value: unknown): never => {
    throw new Error(
      `FIG 图层「${n.name}」的 ${field}=${String(value)} 暂不支持无损导入；原文件未修改`,
    )
  }
  const choice = <T>(field: string, values: Record<string, T>, fallback: T): T => {
    const value = r[field]
    if (value === undefined) return fallback
    if (typeof value !== 'string') return unsupported(field, value)
    return Object.hasOwn(values, value) ? values[value] : unsupported(field, value)
  }
  const distance = (field: string, fallback = 0) => {
    const value = r[field] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e5)
      unsupported(field, value)
    return value as number
  }
  const mode = choice(
    'stackMode',
    { NONE: 'none', HORIZONTAL: 'horizontal', VERTICAL: 'vertical' } as const,
    'none',
  )
  const hasLayout = mode !== 'none'
  const align = { MIN: 'start', CENTER: 'center', MAX: 'end' } as const
  const stackAlign = { MIN: 'start', CENTER: 'unsafe-center', MAX: 'unsafe-end' } as const
  // Older layout generations have different sizing/alignment contracts. Do not
  // apply a modern interpretation to a non-default legacy value.
  if (hasLayout) {
    for (const [field, neutral] of Object.entries({
      stackPadding: 0,
      stackCounterAlign: 'MIN',
      stackJustify: 'MIN',
      stackAlign: 'MIN',
      stackWidth: 'FIXED',
      stackHeight: 'FIXED',
      stackCounterAlignContent: 'AUTO',
    })) {
      if (r[field] !== undefined && r[field] !== neutral) unsupported(field, r[field])
    }
    // Figma "first on top" is authored order reversed, the same child flip the native reader applies.
    if (r.stackReverseZIndex !== undefined && r.stackReverseZIndex !== false) {
      if (r.stackReverseZIndex !== true) unsupported('stackReverseZIndex', r.stackReverseZIndex)
      reverseZ.add(n.id)
    }
    if (!['frame', 'group', 'section'].includes(n.kind)) unsupported('stackMode', r.stackMode)
    const horizontal = distance('stackHorizontalPadding'),
      vertical = distance('stackVerticalPadding'),
      // Negative spacing is authored overlap. Padding stays non-negative.
      spacing = (field: string) => {
        const value = r[field] ?? 0
        if (typeof value !== 'number' || !Number.isFinite(value) || value < -1e5 || value > 1e5)
          unsupported(field, value)
        return value as number
      }
    n.layout = {
      ...defaultLayout(),
      mode,
      gap: spacing('stackSpacing'),
      lineGap: Number.isNaN(r.stackCounterSpacing) ? spacing('stackSpacing') : spacing('stackCounterSpacing'),
      padding: [
        vertical,
        distance('stackPaddingRight', horizontal),
        distance('stackPaddingBottom', vertical),
        horizontal,
      ],
      wrap: choice('stackWrap', { NO_WRAP: false, WRAP: true }, false),
      justify: choice(
        'stackPrimaryAlignItems',
        { ...stackAlign, SPACE_BETWEEN: 'space-between', SPACE_EVENLY: 'space-evenly', SPACE_AROUND: 'space-around' } as const,
        'start',
      ),
      align: r.stackCounterAlignItems === 'BASELINE'
        ? (note?.('stackCounterAlignItems=BASELINE'), 'start')
        : choice('stackCounterAlignItems', stackAlign, 'start'),
    }
  }
  const sizing = defaultSizing()
  let hasSizing = hasLayout
  if (hasLayout) {
    // Native calibration frames 44:3, 52:3, 62:2, 62:191 and 79:2 omit
    // primary sizing and use WITH_IMPLICIT_SIZE on the counter axis. The same
    // Figma nodes report AUTO/AUTO (HUG/HUG) through the Plugin API.
    const sizes = {
        FIXED: 'fixed',
        RESIZE_TO_FIT: 'hug',
        RESIZE_TO_FIT_WITH_IMPLICIT_SIZE: 'hug',
      } as const,
      primary = choice('stackPrimarySizing', sizes, 'hug'),
      counter = choice('stackCounterSizing', sizes, 'fixed')
    sizing.width = mode === 'horizontal' ? primary : counter
    sizing.height = mode === 'horizontal' ? counter : primary
  }
  const parentMode = parent?.stackMode,
    parentHasLayout = parentMode === 'HORIZONTAL' || parentMode === 'VERTICAL'
  if (parentHasLayout && r.stackPositioning !== undefined) {
    sizing.absolute = choice('stackPositioning', { AUTO: false, ABSOLUTE: true }, false)
    hasSizing = true
  }
  // FIG retains stack fields when auto-layout is disabled or a child becomes
  // absolute. These dormant values must not impose active fill/alignment rules.
  if (parentHasLayout && !sizing.absolute) {
    for (const field of [
      'stackChildMarginTop',
      'stackChildMarginRight',
      'stackChildMarginBottom',
      'stackChildMarginLeft',
    ])
      if (r[field] !== undefined && r[field] !== 0) unsupported(field, r[field])
    const grow = r.stackChildPrimaryGrow ?? 0,
      self = choice(
        'stackChildAlignSelf',
        { ...align, STRETCH: 'stretch', AUTO: null } as const,
        null,
      )
    if (grow !== 0 && grow !== 1) unsupported('stackChildPrimaryGrow', grow)
    if (grow || self !== null) {
      if (grow) sizing[parentMode === 'HORIZONTAL' ? 'width' : 'height'] = 'fill'
      if (self === 'stretch') sizing[parentMode === 'HORIZONTAL' ? 'height' : 'width'] = 'fill'
      sizing.alignSelf = self
      hasSizing = true
    }
  }
  for (const [field, prefix] of [
    ['minSize', 'min'],
    ['maxSize', 'max'],
  ] as const) {
    if (r[field]?.value === undefined) continue // OptionalVector with no value means no bound.
    const { x, y } = r[field].value
    // Figma stores an absent maximum as +Infinity. The editable model already
    // uses 1e7 as that unconstrained ceiling; the source sentinel is retained.
    const axis = (value: number) => {
      if (prefix === 'max' && value === Infinity) return 1e7
      // An explicit zero minimum is below the editable floor. Keep 0.01 and the source zero.
      if (prefix === 'min' && value === 0) return 0.01
      if (!Number.isFinite(value) || value < 0.01 || value > 1e7) unsupported(field, `${x},${y}`)
      return value
    }
    sizing[`${prefix}Width`] = axis(x)
    sizing[`${prefix}Height`] = axis(y)
    if (prefix === 'max' && (x === Infinity || y === Infinity))
      note?.(`maxSize=${x === Infinity ? '+Infinity' : x},${y === Infinity ? '+Infinity' : y}`)
    if (prefix === 'min' && (x === 0 || y === 0)) note?.(`minSize=${x},${y}`)
    hasSizing = true
  }
  if (sizing.minWidth > sizing.maxWidth || sizing.minHeight > sizing.maxHeight)
    unsupported('minSize/maxSize', 'inverted bounds')
  if (hasSizing) n.sizing = sizing
  if (r.horizontalConstraint !== undefined || r.verticalConstraint !== undefined) {
    const anchors = { ...align, STRETCH: 'stretch', SCALE: 'scale' } as const,
      reference = parent?.size
    n.constraints = {
      horizontal: choice('horizontalConstraint', anchors, 'start'),
      vertical: choice('verticalConstraint', anchors, 'start'),
      ...(reference && Number.isFinite(reference.x) && reference.x > 0
        ? { referenceWidth: reference.x }
        : {}),
      ...(reference && Number.isFinite(reference.y) && reference.y > 0
        ? { referenceHeight: reference.y }
        : {}),
    }
  }
}
function figStrokeAlign(align: unknown): Stroke['align'] {
  switch (align ?? 'CENTER') {
    case 'INSIDE': return 'inside'
    case 'OUTSIDE': return 'outside'
    case 'CENTER': return 'center'
    default: throw new Error(`FIG 描边对齐 ${String(align)} 暂不支持；原文件未修改`)
  }
}
function figStrokeJoin(join: unknown): Stroke['join'] {
  switch (join ?? 'MITER') {
    case 'ROUND': return 'round'
    case 'BEVEL': return 'bevel'
    case 'MITER': return 'miter'
    default: throw new Error(`FIG 描边连接 ${String(join)} 暂不支持；原文件未修改`)
  }
}
/** Kiwi StrokeCap. NONE is the native butt cap. Decorative caps become end markers. */
function figStrokeCap(cap: unknown, warnings: { add(message: string): unknown }): { cap: Stroke['cap']; endMarker?: Stroke['endMarker'] } {
  switch (cap ?? 'NONE') {
    case 'NONE':
    case 'BUTT':
      return { cap: 'butt' }
    case 'ROUND':
      return { cap: 'round' }
    case 'SQUARE':
      return { cap: 'square' }
    case 'ARROW_LINES':
    case 'ARROW_EQUILATERAL':
      return { cap: 'butt', endMarker: 'arrow' }
    case 'TRIANGLE_FILLED':
      return { cap: 'butt', endMarker: 'triangle' }
    case 'DIAMOND_FILLED':
      return { cap: 'butt', endMarker: 'diamond' }
    case 'CIRCLE_FILLED':
      return { cap: 'butt', endMarker: 'circle' }
    default:
      warnings.add(`FIG strokeCap=${String(cap)} 尚不能无损表达，已按平头保留`)
      return { cap: 'butt' }
  }
}
export function importFig(bytes: Uint8Array, name = '导入 FIG'): ImportedDesign & { backend: 'typescript-fig' } {
  const { data, files } = decodeFig(bytes),
    doc = blank(name),
    warnings = boundedImportWarnings(),
    source: any[] = data.nodeChanges || []
  if (source.length > 20000) throw new Error('FIG 图层超过 20000 个')
  const capEntries: [string, Stroke['cap'], StrokeMarker][] = JSON.parse(fig_stroke_caps_json())
  const strokeCaps = new Map(capEntries.map(([name, cap, marker]) => [name, { cap, marker }]))
  const records = new Map<string, any>()
  for (const n of source) {
    const id = guid(n.guid)
    if (n.phase === 'REMOVED') records.delete(id)
    else records.set(id, { ...records.get(id), ...n })
  }
  const p3 = [...records.values()].some(r => !r.internalOnly && r.type === 'DOCUMENT' &&
    (r.documentColorProfile === 'DISPLAY_P3' || r.colorProfile === 'DISPLAY_P3'))
  const colorSpace: FigColorSpace = p3 ? 'display-p3' : 'srgb'
  if (p3) {
    doc.colorManagement = { ...defaultColorSettings(), documentSpace: colorSpace }
    doc.rasterProfile = 'figma'
  }
  for (const record of records.values()) {
    if (record.internalOnly && record.type !== 'DOCUMENT' && record.type !== 'CANVAS') continue
    for (const profile of [record.documentColorProfile, record.colorProfile])
      if (profile !== undefined && (p3 ? profile !== 'DISPLAY_P3' : !['LEGACY', 'SRGB'].includes(profile)))
        throw new Error(`FIG 色域 ${profile} 暂不能无损导入；请保留原文件，或从 Figma 导出明确转换为 sRGB 的副本`)
    if (record.interpolationColorSpace !== undefined && record.interpolationColorSpace !== 'DEFAULT')
      throw new Error(`FIG 插值色彩空间 ${record.interpolationColorSpace} 暂不能无损导入；原文件未修改`)
  }
  const ids = new Map([...records.keys()].map((id) => [id, uid()])),
    blobs = data.blobs || [],
    reverseZ = new Set<string>()
  const receipts: FigReceipts = new Map()
  const resolveLayer = (g: any) => {
    const source = guid(g)
    const record = records.get(source)
    if (!record || record.internalOnly || record.type === 'DOCUMENT' || record.type === 'CANVAS') return undefined
    return ids.get(source)
  }
  const keepFonts = (layer: DesignNode, record: any) => {
    const importedFonts = importFigTextRuns(layer, record, warnings, colorSpace)
    if (importedFonts.style || Object.keys(importedFonts.runs).length) {
      doc.designSystem ??= emptySystem()
      doc.designSystem.fontSources ??= {}
      doc.designSystem.fontSources[layer.id] = importedFonts
      warnings.add(`字体 ${record.fontName?.family || importedFonts.style || '片段字体'} 尚需匹配，已保留文字内容`)
    }
  }
  const getBlob = (index: number) => {
    const b = blobs[index]?.bytes
    if (!(b instanceof Uint8Array)) throw new Error('FIG 缺少二进制资源')
    return b
  }
  const toPaint = (p: any): Paint => {
    if (p.interpolationColorSpace !== undefined && p.interpolationColorSpace !== 'DEFAULT')
      throw new Error(`FIG 渐变插值色彩空间 ${p.interpolationColorSpace} 暂不能无损导入；原文件未修改`)
    const kind: Paint['kind'] = (
      {
        SOLID: 'solid',
        GRADIENT_LINEAR: 'linear',
        GRADIENT_RADIAL: 'radial',
        GRADIENT_ANGULAR: 'angular',
        GRADIENT_DIAMOND: 'diamond',
        IMAGE: 'image',
      } as Record<string, Paint['kind']>
    )[p.type]
    if (!kind) throw new Error(`FIG 填充 ${p.type} 暂不支持`)
    const result = {
      ...paint(rgb(p.color, colorSpace), kind),
      opacity: (p.opacity ?? 1) * (p.type === 'SOLID' ? (p.color?.a ?? 1) : 1),
      visible: p.visible !== false,
      blend: String(p.blendMode || 'NORMAL')
        .toLowerCase()
        .replaceAll('_', '-') as Paint['blend'],
    }
    if (p.stops)
      result.stops = p.stops.map((s: any) => ({
        offset: s.position ?? s.offset,
        color: gradientStopColor(s.color, colorSpace),
      }))
    // FIG maps normalized node coordinates into gradient space; Paint stores
    // the opposite direction. Image placement has its own convention below.
    if(kind==='linear'){result.angle=0;result.transform=inverse(matrix(p.transform))}
    else if (p.transform) result.transform = matrix(p.transform)
    if (kind === 'image') {
      const hash = Array.from(p.image?.hash || [], (v: any) =>
        Number(v).toString(16).padStart(2, '0'),
      ).join('')
      const bytes =
        files[`images/${hash}`] ||
        (p.image?.dataBlob !== undefined ? getBlob(p.image.dataBlob) : undefined)
      if (!bytes) throw new Error('FIG 缺少图片资源')
      const mime =
        bytes[0] === 137
          ? 'png'
          : bytes[0] === 255
            ? 'jpeg'
            : String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
              ? 'webp'
              : null
      if (!mime) throw new Error('FIG 图片格式暂不支持')
      result.image = `data:image/${mime};base64,${bytesData(bytes)}`
      result.adjust = figImageAdjust(p)
      if (p.imageScaleMode !== undefined && !['STRETCH','FIT','FILL','TILE'].includes(p.imageScaleMode))
        throw new Error(`FIG 图片缩放 ${p.imageScaleMode} 暂不支持`)
      if (p.imageScaleMode === 'TILE') {
        const modes={RECTANGULAR:'grid',HORIZONTAL_HEXAGONAL:'stagger_horizontal',VERTICAL_HEXAGONAL:'stagger_vertical'} as const
        const mode=p.patternTileType ?? 'RECTANGULAR'
        if(!(mode in modes))throw new Error(`FIG 平铺模式 ${mode} 暂不支持`)
        const align = (value: unknown, field: string) => {
          if (value === undefined || value === 'START') return 'start' as const
          if (value === 'CENTER') return 'center' as const
          if (value === 'END') return 'end' as const
          throw new Error(`FIG 平铺对齐 ${field}=${String(value)} 暂不支持；原文件未修改`)
        }
        const scale = p.scale ?? 1
        const rotation = p.rotation ?? 0
        const spacingX = p.patternSpacing?.x ?? (typeof p.spacing === 'number' ? p.spacing : 0)
        const spacingY = p.patternSpacing?.y ?? (typeof p.spacing === 'number' ? p.spacing : 0)
        if (![scale, rotation, spacingX, spacingY].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7)
          || scale <= 0 || spacingX < 0 || spacingY < 0)
          throw new Error('FIG 平铺参数无效；原文件未修改')
        result.tile={
          mode:modes[mode as keyof typeof modes],
          size:[0,0],
          offset:[0,0],
          alignment:[align(p.horizontalAlignment, 'horizontalAlignment'), align(p.verticalAlignment, 'verticalAlignment')],
          ...(scale !== 1 ? { scale } : {}),
          ...(rotation !== 0 ? { rotation } : {}),
          ...(spacingX !== 0 || spacingY !== 0 ? { spacing: [spacingX, spacingY] as [number, number] } : {}),
        }
      }

      result.fit =
        p.imageScaleMode === 'FIT'
          ? 'contain'
          : p.imageScaleMode === 'STRETCH'
            ? 'stretch'
            : 'cover'
    }
    return result
  }
  const strokesOf = (record: any, note?: (message: string) => void): Stroke[] => {
    let strokeWidth = record.strokeWeight ?? 1
    if (record.borderStrokeWeightsIndependent && record.strokePaints?.length) {
      const borders = [record.borderTopWeight, record.borderRightWeight, record.borderBottomWeight, record.borderLeftWeight]
        .map((value) => value ?? strokeWidth)
      if (!borders.every((value: number) => value === borders[0])) {
        // One kernel stroke width. Record the four edges instead of dropping the node.
        note?.('borderStrokeWeightsIndependent(non-uniform)')
        warnings.add('FIG 独立非均匀边描边已保留统一线宽，四边宽度尚未分别绘制')
      } else strokeWidth = borders[0]
    }
    const dash: unknown = record.dashPattern ?? []
    if (!Array.isArray(dash) || dash.some((value) => !Number.isFinite(value) || value < 0) ||
      (dash.length > 0 && dash.every((value) => value === 0)))
      throw new Error('FIG 虚线参数暂不能无损表达；原文件未修改')
    const mappedCap = figStrokeCap(record.strokeCap, warnings)
    return (record.strokePaints || []).map((p: any) => ({
      ...stroke(),
      paint: toPaint(p),
      width: strokeWidth,
      dash: dash.join(' '),
      align: figStrokeAlign(record.strokeAlign),
      cap: mappedCap.cap,
      join: figStrokeJoin(record.strokeJoin),
      ...(mappedCap.endMarker ? { endMarker: mappedCap.endMarker } : {}),
    }))
  }
  const effectsOf = (record: any): Effect[] => (record.effects || []).map((x: any) => {
    const kind = (
      {
        DROP_SHADOW: 'shadow',
        INNER_SHADOW: 'inner-shadow',
        LAYER_BLUR: 'blur',
        FOREGROUND_BLUR: 'blur',
        BACKGROUND_BLUR: 'background-blur',
        GLASS: 'glass',
        GRAIN: 'texture',
      } as Record<string, Parameters<typeof effect>[0]>
    )[x.type]
    if (!kind) throw new Error(`FIG 效果 ${x.type} 暂不支持`)
    if (kind === 'glass' && x.bevelSize !== undefined && (!Number.isFinite(x.bevelSize) || x.bevelSize < 0.001 || x.bevelSize > 1000))
      throw new Error('FIG 玻璃倒角宽度无效；原文件未修改')
    if (
      kind === 'glass' &&
      ![
        x.refractionRadius,
        x.refractionIntensity,
        x.chromaticAberration,
        x.specularAngle,
        x.specularIntensity,
      ].every(Number.isFinite)
    )
      throw new Error('FIG 玻璃参数不完整；原文件未修改')
    if (
      kind === 'texture' &&
      (!Number.isFinite(x.noiseSize?.x) ||
        !Number.isFinite(x.noiseSize?.y) ||
        typeof x.clipToShape !== 'boolean')
    )
      throw new Error('FIG 纹理参数不完整；原文件未修改')
    return {
      ...effect(kind),
      color: rgb(x.color, colorSpace),
      opacity: x.color?.a ?? 1,
      x: x.offset?.x || 0,
      y: x.offset?.y || 0,
      radius: x.radius || 0,
      spread: x.spread || 0,
      visible: x.visible !== false,
      ...(kind === 'glass'
        ? {
            glass: {
              ...(x.bevelSize !== undefined && x.bevelSize !== 1 ? { bevelSize: x.bevelSize } : {}),
              depth: x.refractionRadius,
              refraction: x.refractionIntensity,
              dispersion: x.chromaticAberration,
              lightAngle: x.specularAngle,
              lightIntensity: x.specularIntensity,
            },
          }
        : {}),
      ...(kind === 'texture'
        ? {
            texture: {
              noiseSize: [x.noiseSize.x, x.noiseSize.y] as [number, number],
              clipToShape: x.clipToShape,
            },
          }
        : {}),
      ...(x.showShadowBehindNode === true ? { showShadowBehindNode: true } : {}),
    }
  })
  doc.pages = []
  for (const [key, r] of records) {
    if (!includeFigRecord(r, records, guid)) continue
    if (r.type === 'CANVAS') {
      const id = ids.get(key)!
      const guides = figGuides(r, id)
      doc.pages.push({
        id,
        name: r.name || '页面',
        children: [],
        background: rgb(r.backgroundColor || { r: 1, g: 1, b: 1 }, colorSpace),
        ...(guides ? { guides } : {}),
      })
      continue
    }
    // Native FIG stores ordinary groups as resize-to-fit FRAME records.
    // They have no clipping/auto-layout frame semantics (desigma fig.rs).
    const nativeGroup = r.type === 'FRAME' && r.resizeToFit === true && r.isStateGroup !== true &&
      (r.stackMode === undefined || r.stackMode === 'NONE')
    const kind = nativeGroup ? 'group' : figNodeKind(r, warnings)
    const rawWidth = r.size?.x
    const rawHeight = r.size?.y
    const axis = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const width = axis(rawWidth) ?? 100
    const height = axis(rawHeight) ?? 100
    const unresolvedSize = r.size !== undefined && (axis(rawWidth) === undefined || axis(rawHeight) === undefined)
    if (![width, height].every((v) => v >= 0 && v <= 1e7))
      throw new Error('FIG 图层尺寸无效；原文件未修改')
    const hairline = (kind === 'line' || kind === 'vector') && Math.max(width, height) > 0 && Math.min(width, height) < 0.01
    const zeroLine = hairline
    const n = node(zeroLine ? 'vector' : kind, 0, 0, Math.max(0.01, width), Math.max(0.01, height))
    if (zeroLine) {
      // The model requires a positive layout box; keep the authored path itself
      // exact instead of turning a horizontal/vertical line into a diagonal.
      n.network = {
        vertices: [{ id: '0', x: 0, y: 0 }, { id: '1', x: width, y: height }],
        edges: [{ id: '0', from: '0', to: '1' }], fillRule: 'nonzero',
      }
      warnings.add('零尺寸线条已保留为精确可编辑矢量路径，逻辑包围盒使用最小正尺寸')
    }
    n.id = ids.get(key)!
    if (unresolvedSize) figNote(receipts, n.id, `size=${String(rawWidth)},${String(rawHeight)}`)
    else if (!zeroLine && (width < 0.01 || height < 0.01)) figNote(receipts, n.id, `size=${width},${height}`)
    n.name = r.name || r.type
    n.transform = matrix(r.transform)
    n.visible = r.visible !== false
    n.locked = !!r.locked
    n.opacity = r.opacity ?? 1
    n.blend = String(r.blendMode || 'NORMAL')
      .toLowerCase()
      .replaceAll('_', '-') as typeof n.blend
    n.mask = !!r.mask
    if (n.mask && r.maskType !== undefined && !['ALPHA', 'LUMINANCE', 'OUTLINE'].includes(r.maskType))
      throw new Error(`FIG 蒙版 ${r.maskType} 暂不支持；原文件未修改`)
    n.maskType = r.maskType === 'OUTLINE' ? 'outline' : r.maskType === 'LUMINANCE' ? 'luminance' : 'alpha'
    n.clip = kind === 'frame' && !r.frameMaskDisabled
    if (kind === 'polygon' || kind === 'star') { n.points = r.count ?? n.points; n.cornerRadius = r.cornerRadius ?? 0 }
    if (kind === 'ellipse' && r.arcData) {
      const start=r.arcData.startingAngle ?? 0
      let sweep=(r.arcData.endingAngle ?? 0)-start
      if(Math.abs(sweep)===Math.fround(Math.PI*2))sweep=Math.sign(sweep)*Math.PI*2
      n.arc={startAngle:start,sweepAngle:sweep,innerRadius:r.arcData.innerRadius ?? 0}
    }
    if (kind === 'star') n.innerRadius = r.starInnerScale ?? n.innerRadius
    n.fills = (r.fillPaints || r.backgroundPaints || []).map(toPaint)
    n.strokes = strokesOf(r, (message) => figNote(receipts, n.id, message))
    n.radii = [
      r.rectangleTopLeftCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleTopRightCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleBottomRightCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleBottomLeftCornerRadius ?? r.cornerRadius ?? 0,
    ]
    n.smoothing = r.cornerSmoothing || 0
    n.effects = effectsOf(r)
    for (const x of r.effects || []) {
      if (x?.blendMode && x.blendMode !== 'NORMAL') {
        figNote(receipts, n.id, `effectBlendMode=${x.blendMode}`)
        warnings.add(`FIG 效果混合 ${x.blendMode} 已保留效果，混合方式尚未绘制`)
      }
    }
    if (r.vectorData?.vectorNetworkBlob !== undefined) {
      const normalized=r.vectorData.normalizedSize
      const axis=(nodeSize:number,source:number|undefined)=>{
        if(source===undefined)return 1
        const value=nodeSize/source
        return Number.isFinite(value)&&value>0?value:1
      }
      const sx=axis(n.width,normalized?.x),sy=axis(n.height,normalized?.y)
      try{
        const piece=vectorBlob(getBlob(r.vectorData.vectorNetworkBlob),sx,sy,warnings,r)
        if(piece.strokeCap||piece.strokeJoin){
          const cap=piece.strokeCap?figStrokeCap(piece.strokeCap,warnings):undefined
          const join=piece.strokeJoin?figStrokeJoin(piece.strokeJoin):undefined
          n.strokes=n.strokes.map(item=>({...item,...(cap?{cap:cap.cap,...(cap.endMarker?{endMarker:cap.endMarker}:{})}:{}),...(join?{join}:{})}))
        }
        const {strokeCap: _strokeCap, strokeJoin: _strokeJoin, ...geometry}=piece
        // Rounded rectangles already own their corner radii. A derived outline
        // is not a second authoritative path on a non-vector layer.
        if (n.kind !== 'vector') delete geometry.vectorGeometry
        if (n.kind !== 'vector' && n.kind !== 'line') delete geometry.network
        Object.assign(n,geometry)
      }
      catch(error){warnings.add(`FIG 矢量 ${n.name||n.id} 的网络几何未能解码，已保留包围盒：${error instanceof Error?error.message:error}`)}
    }
    if(r.type==='VECTOR'&&Array.isArray(r.fillGeometry)&&r.fillGeometry.length){
      const paths=r.fillGeometry.map((entry:any)=>({rule:entry.windingRule==='ODD'||entry.windingRule==='EVENODD'?'evenodd':'nonzero',commands:JSON.parse(decode_fig_fill_commands_json(getBlob(entry.commandsBlob))) as import('./model').CurveCommand[]}))
      if(paths.some((p:any)=>p.rule!==paths[0].rule))throw Error('FIG 混合区域填充规则需要独立几何工作集')
      const source=n.vectorGeometry??(n.network?JSON.parse(network_geometry_json(JSON.stringify(n.network))) as NonNullable<DesignNode['vectorGeometry']>:undefined)
      if(!source&&n.strokes.some(s=>s.visible&&s.width>0))throw Error('FIG 仅提供填充轮廓，缺少可精确保留描边的路径')
      n.vectorGeometry={fillRule:paths[0].rule,fill:paths.flatMap((p:any)=>p.commands),...(source?{stroke:source.stroke??source.fill}:{})}
      delete n.network
    }
    applyFigFacet(n, r, resolveLayer, receipts, warnings)
    if (r.type === 'STICKY' || r.type === 'CODE_BLOCK' || r.type === 'SHAPE_WITH_TEXT') {
      n.text = r.textData?.characters || ''
      if (r.type === 'STICKY' && Number.isFinite(r.fontSize)) n.fontSize = Math.max(1, r.fontSize)
      if (r.type === 'STICKY') keepFonts(n, r)
    }
    if (kind === 'text') {
      n.text = r.textData?.characters || ''
      n.fontSize = r.fontSize || 16
      n.textStyle = {
        ...defaultTextStyle(),
        wrap: r.textAutoResize !== 'WIDTH_AND_HEIGHT',
        paragraphSpacing: r.paragraphSpacing || 0,
        paragraphIndent: r.paragraphIndent || 0,
        align:
          r.textAlignHorizontal === 'CENTER'
            ? 'center'
            : r.textAlignHorizontal === 'RIGHT'
              ? 'end'
              : r.textAlignHorizontal === 'JUSTIFIED'
                ? 'justify'
                : 'start',
      }
      if (r.textCase === 'UPPER' || r.textCase === 'LOWER') n.textStyle.textCase = r.textCase.toLowerCase()
      else if (r.textCase && r.textCase !== 'ORIGINAL') warnings.add(`文字大小写 ${r.textCase} 尚需核对`)
      // Preserve authoring metrics instead of silently using 1.35em/zero.
      if (r.lineHeight?.units === 'PIXELS') n.textStyle.lineHeight = r.lineHeight.value / n.fontSize
      if (r.lineHeight?.units === 'PERCENT') n.textStyle.lineHeight = r.lineHeight.value / 100
      if (r.letterSpacing?.units === 'PIXELS') n.textStyle.letterSpacing = r.letterSpacing.value
      if (r.letterSpacing?.units === 'PERCENT') n.textStyle.letterSpacing = r.letterSpacing.value * n.fontSize / 100
      keepFonts(n, r)
      importFigTextExtras(n, r, warnings)
    }
    if (r.variableConsumptionMap) {
      const kept = receipts.get(n.id) ?? {}
      kept.figVariableConsumption = JSON.stringify(r.variableConsumptionMap)
      receipts.set(n.id, kept)
    }
    if (Array.isArray(r.variableModeBySetMap?.entries) && r.variableModeBySetMap.entries.length) {
      const kept = receipts.get(n.id) ?? {}
      kept.figVariableModes = JSON.stringify(r.variableModeBySetMap)
      receipts.set(n.id, kept)
    }
    if (r.type === 'SYMBOL') n.component = { variants: {}, properties: {} }
    if (r.type === 'INSTANCE') n.instance = { componentId: '', overrides: {}, propertyValues: {} }
    if (r.type === 'BOOLEAN_OPERATION') n.network = { vertices: [], edges: [], fillRule: 'evenodd' }
    if (r.type === 'BOOLEAN_OPERATION') {
      const operations = { UNION: 'union', SUBTRACT: 'subtract', INTERSECT: 'intersect', XOR: 'exclude' } as const
      const operation = r.booleanOperation ?? 'UNION'
      if (!(operation in operations)) throw new Error(`FIG 布尔运算 ${operation} 暂不支持；原文件未修改`)
      n.booleanOperation = operations[operation as keyof typeof operations]
    }
    importLayout(n, r, records.get(guid(r.parentIndex?.guid)), reverseZ, (message) => {
      figNote(receipts, n.id, message)
      if (message === 'stackCounterAlignItems=BASELINE')
        warnings.add('FIG 基线对齐已原样保留，当前布局仍使用起点，没有改记成其他对齐')
    })
    doc.nodes[n.id] = n
  }
  const ordered = [...records].sort((a, b) => {
    const left = String(a[1].parentIndex?.position || ''),
      right = String(b[1].parentIndex?.position || '')
    return left < right ? -1 : left > right ? 1 : 0
  })
  for (const [key, r] of ordered) {
    const id = ids.get(key)!,
      n = doc.nodes[id]
    if (!n) continue
    const parent = ids.get(guid(r.parentIndex?.guid))
    const children =
      parent && (doc.nodes[parent]?.children || doc.pages.find((p) => p.id === parent)?.children)
    if (!children) throw new Error('FIG 图层父节点缺失')
    children.push(id)
  }
  for (const id of reverseZ) {
    const layer = doc.nodes[id]
    if (!layer) continue
    layer.children.reverse()
    const bindings = receipts.get(id) ?? {}
    bindings.figStackReverseZIndex = 'true'
    receipts.set(id, bindings)
  }
  if (!doc.pages.length) throw new Error('FIG 文件没有可导入页面')
  importFigComponents(doc, records, ids, toPaint, strokesOf, warnings, receipts, effectsOf)
  // The shared model's direct mask owns its whole container. Native FIG masks
  // only following siblings. Explicit identity groups keep all original node
  // IDs, local coordinates, order and component override keys intact.
  for(const parent of [...Object.values(doc.nodes),...doc.pages]){
    const indices=fig_mask_suffixes(Uint8Array.from(parent.children,id=>Number(!!doc.nodes[id]?.mask&&doc.nodes[id].visible)))
    const page=!('kind' in parent)
    if(!indices.length||!page&&indices.length===1&&indices[0]===0)continue
    if('kind' in parent&&(parent.booleanOperation||parent.layout&&parent.layout.mode!=='none')){
      warnings.add('FIG 自动布局或布尔结构中的非首位或多重蒙版尚需核对，原始顺序已保留');continue
    }
    for(const at of indices){
      if(!page&&at===0)continue
      const group=node('group',0,0,'width' in parent?parent.width:1,'height' in parent?parent.height:1)
      group.name='Mask group';group.blend='pass-through';group.fills=[];group.strokes=[];group.effects=[];group.clip=false
      group.children=parent.children.slice(at)
      doc.nodes[group.id]=group
      parent.children=[...parent.children.slice(0,at),group.id]
    }
  }
  assertFigStructure(doc)
  importFigPrototype(records, ids, doc, receipts)
  parkFigReceipts(doc, receipts)
  applyFigDocumentSemantics(doc, records, ids, guid, { toPaint, effectsOf, strokesOf, fallbackName: name }, warnings)
  importFigVariableNodes(doc, records, ids)
  storeFigVariables(doc, data)
  const unhandledProps = new Set<string>()
  for (const record of records.values()) {
    for (const def of record.componentPropDefs || []) {
      if (def?.isDeleted || def?.type === 'VARIANT' || def?.type === 'BOOL' || def?.type === 'TEXT' || def?.type === 'INSTANCE_SWAP') continue
      unhandledProps.add(String(def?.type || 'unknown'))
    }
  }
  if (unhandledProps.size)
    warnings.add(`FIG 组件属性 ${[...unhandledProps].join(', ')} 尚不能执行；变体、布尔、文本和实例交换已导入`)
  if ([...records.values()].some((r) => r.prototypeInteractions))
    warnings.add('原型交互已保留为来源数据，尚不能直接播放')
  doc.schemaVersion = Object.values(doc.nodes).some((n) =>
    n.effects.some((e) => e.glass || e.texture),
  )
    ? 5
    : 4
  if(Object.values(doc.nodes).some(n=>n.arc || n.cornerRadius))doc.schemaVersion=Math.max(7,doc.schemaVersion) as typeof doc.schemaVersion
  if (Object.values(doc.nodes).some(n=>[...n.fills,...n.strokes.map(s=>s.paint)].some(p=>p.adjust))) doc.schemaVersion = 13
  if(Object.values(doc.nodes).some(n=>[...n.fills,...n.strokes.map(s=>s.paint)].some(p=>p.tile)))doc.schemaVersion=Math.max(14,doc.schemaVersion) as typeof doc.schemaVersion
  if(Object.values(doc.nodes).some(n=>n.vectorGeometry))doc.schemaVersion=16
  else if(Object.values(doc.nodes).some(n=>n.network?.filledFaces!==undefined))doc.schemaVersion=Math.max(10,doc.schemaVersion) as typeof doc.schemaVersion
  if (Object.values(doc.nodes).some(n=>(n.textStyle?.textCase && n.textStyle.textCase !== 'original') || n.textRuns?.some(r=>r.textCase !== undefined))) doc.schemaVersion = Math.max(15,doc.schemaVersion) as typeof doc.schemaVersion
  if (Object.values(doc.nodes).some(n=>n.textRuns?.some(r=>r.letterSpacing !== undefined || r.lineHeight !== undefined))) doc.schemaVersion = Math.max(21, doc.schemaVersion) as typeof doc.schemaVersion
  if (hasStrokeMarkers(doc) || hasLayerExports(doc)) doc.schemaVersion = Math.max(8, doc.schemaVersion) as typeof doc.schemaVersion
  if (hasLocalTools(doc)) doc.schemaVersion = Math.max(10, doc.schemaVersion) as typeof doc.schemaVersion
  if (doc.pages.some(page => page.guides?.length)) doc.schemaVersion = Math.max(11, doc.schemaVersion) as typeof doc.schemaVersion
  if (Object.values(doc.designSystem?.styles || {}).some(style => style.strokes?.length || style.effects?.length))
    doc.schemaVersion = Math.max(12, doc.schemaVersion) as typeof doc.schemaVersion
  if (Object.values(doc.designSystem?.styles || {}).some(style => style.kind === 'text' && style.value && typeof style.value === 'object' && 'textCase' in style.value && style.value.textCase && style.value.textCase !== 'original'))
    doc.schemaVersion = Math.max(15, doc.schemaVersion) as typeof doc.schemaVersion
  if (hasSchema20Features(doc)) doc.schemaVersion = Math.max(20, doc.schemaVersion) as typeof doc.schemaVersion
  return { document: doc, backend: 'typescript-fig', ...warnings.result() }
}
