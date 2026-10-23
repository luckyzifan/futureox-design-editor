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
  type DesignNode,
  type Matrix,
  type Paint,
  type Network,
} from './model'
import type { ImportedDesign } from './import-svg'
import { emptySystem } from './design-system'
import { importFigTextRuns } from './import-fig-text'
import { figImageAdjust } from './import-fig-image'

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
/** Interpret the embedded schema. Imported names are data, never generated JS. */
export function decodeKiwi(schema: Schema, bytes: Uint8Array): Record<string, any> {
  if (schema.definitions.length > 4096) throw new Error('FIG schema 过大')
  const defs = new Map(schema.definitions.map((d) => [d.name, d]))
  if (defs.size !== schema.definitions.length) throw new Error('FIG schema 类型名称重复')
  const bb = new ByteBuffer(bytes)
  let work = 0
  const read = (type: string, depth: number): any => {
    if (++work > 2_000_000 || depth > 128) throw new Error('FIG 解码预算超限')
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
    const result: Record<string, any> = Object.create(null),
      byId = new Map(d.fields.map((f) => [f.value, f]))
    const field = (f: Definition['fields'][number]) => {
      if (!f.type) throw new Error('FIG 字段缺少类型')
      if (f.isArray) {
        const count = bb.readVarUint()
        if (count > MAX || (f.type !== 'byte' && count > 200000)) throw new Error('FIG 数组过大')
        if (f.type === 'byte') {
          const out = new Uint8Array(count)
          for (let i = 0; i < count; i++) out[i] = bb.readByte()
          result[f.name] = out
        } else result[f.name] = Array.from({ length: count }, () => read(f.type!, depth + 1))
      } else result[f.name] = read(f.type, depth + 1)
    }
    if (d.kind === 'STRUCT') for (const f of d.fields) field(f)
    else {
      for (let tag = bb.readVarUint(); tag !== 0; tag = bb.readVarUint()) {
        const f = byId.get(tag)
        if (!f) throw new Error(`FIG schema 缺少字段 ${tag}`)
        field(f)
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
const rgb = (c: any) =>
  '#' +
  ['r', 'g', 'b']
    .map((k) =>
      Math.round(Math.max(0, Math.min(1, Number(c?.[k] || 0))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
// Figma keeps alpha on each stop's Color, independently of paint opacity.
// Use the same portable straight-RGBA representation as the Sketch codec.
const gradientStopColor = (c: any) => {
  const alpha = c?.a ?? 1
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
    throw new Error('FIG 渐变色标透明度无效')
  if (alpha === 1) return rgb(c)
  const components = ['r', 'g', 'b'].map(k => c?.[k] ?? 0)
  if (components.some(v => !Number.isFinite(v) || v < 0 || v > 1))
    throw new Error('FIG 渐变色标颜色无效')
  return `color(srgb ${components.join(' ')} / ${alpha})`
}
const matrix = (m: any): Matrix =>
  m ? [m.m00, m.m10, m.m01, m.m11, m.m02, m.m12] : [1, 0, 0, 1, 0, 0]
const bytesData = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(binary)
}
function vectorBlob(bytes: Uint8Array): Network {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const u = () => {
      const x = v.getUint32(at, true)
      at += 4
      return x
    },
    f = () => {
      const x = v.getFloat32(at, true)
      at += 4
      return x
    }
  const vertices = u(),
    segments = u()
  u()
  if (vertices > 10000 || segments > 20000 || 12 + vertices * 12 + segments * 28 > bytes.length)
    throw new Error('FIG 矢量数据长度无效')
  const g: Network = { vertices: [], edges: [], fillRule: 'evenodd' }
  for (let i = 0; i < vertices; i++) {
    u()
    g.vertices.push({ id: String(i), x: f(), y: f() })
  }
  for (let i = 0; i < segments; i++) {
    u()
    const a = u(),
      tx = f(),
      ty = f(),
      b = u(),
      ux = f(),
      uy = f()
    const p = g.vertices[a],
      q = g.vertices[b]
    if (!p || !q) throw new Error('FIG 矢量端点无效')
    g.edges.push({
      id: String(i),
      from: String(a),
      to: String(b),
      ...(tx || ty || ux || uy
        ? { c1: { x: p.x + tx, y: p.y + ty }, c2: { x: q.x + ux, y: q.y + uy } }
        : {}),
    })
  }
  return g
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
function importLayout(n: DesignNode, r: FigLayoutRecord, parent?: FigLayoutRecord) {
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
      stackReverseZIndex: false,
      stackCounterAlignContent: 'AUTO',
    })) {
      if (r[field] !== undefined && r[field] !== neutral) unsupported(field, r[field])
    }
    if (!['frame', 'group', 'section'].includes(n.kind)) unsupported('stackMode', r.stackMode)
    const horizontal = distance('stackHorizontalPadding'),
      vertical = distance('stackVerticalPadding')
    n.layout = {
      ...defaultLayout(),
      mode,
      gap: distance('stackSpacing'),
      lineGap: distance('stackCounterSpacing'),
      padding: [
        vertical,
        distance('stackPaddingRight', horizontal),
        distance('stackPaddingBottom', vertical),
        horizontal,
      ],
      wrap: choice('stackWrap', { NO_WRAP: false, WRAP: true }, false),
      justify: choice(
        'stackPrimaryAlignItems',
        { ...align, SPACE_BETWEEN: 'space-between' } as const,
        'start',
      ),
      align: choice('stackCounterAlignItems', align, 'start'),
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
    if (![x, y].every((v) => Number.isFinite(v) && v >= 0.01 && v <= 1e7))
      unsupported(field, `${x},${y}`)
    sizing[`${prefix}Width`] = x
    sizing[`${prefix}Height`] = y
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
export function importFig(bytes: Uint8Array, name = '导入 FIG'): ImportedDesign {
  const { data, files } = decodeFig(bytes),
    doc = blank(name),
    warnings = boundedImportWarnings(),
    source: any[] = data.nodeChanges || []
  if (source.length > 20000) throw new Error('FIG 图层超过 20000 个')
  const records = new Map<string, any>()
  for (const n of source) {
    const id = guid(n.guid)
    if (n.phase === 'REMOVED') records.delete(id)
    else records.set(id, { ...records.get(id), ...n })
  }
  for (const record of records.values()) {
    if (record.internalOnly) continue
    for (const profile of [record.documentColorProfile, record.colorProfile])
      if (profile !== undefined && !['LEGACY', 'SRGB'].includes(profile))
        throw new Error(`FIG 色域 ${profile} 暂不能无损导入；请保留原文件，或从 Figma 导出明确转换为 sRGB 的副本`)
    if (record.interpolationColorSpace !== undefined && record.interpolationColorSpace !== 'DEFAULT')
      throw new Error(`FIG 插值色彩空间 ${record.interpolationColorSpace} 暂不能无损导入；原文件未修改`)
  }
  const ids = new Map([...records.keys()].map((id) => [id, uid()])),
    blobs = data.blobs || []
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
      ...paint(rgb(p.color), kind),
      opacity: (p.opacity ?? 1) * (p.type === 'SOLID' ? (p.color?.a ?? 1) : 1),
      visible: p.visible !== false,
      blend: String(p.blendMode || 'NORMAL')
        .toLowerCase()
        .replaceAll('_', '-') as Paint['blend'],
    }
    if (p.stops)
      result.stops = p.stops.map((s: any) => ({
        offset: s.position ?? s.offset,
        color: gradientStopColor(s.color),
      }))
    if (p.transform) result.transform = matrix(p.transform)
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
      result.fit =
        p.imageScaleMode === 'FIT'
          ? 'contain'
          : p.imageScaleMode === 'STRETCH'
            ? 'stretch'
            : 'cover'
    }
    return result
  }
  doc.pages = []
  for (const [key, r] of records) {
    if (r.type === 'DOCUMENT' || r.internalOnly) continue
    if (r.type === 'CANVAS') {
      doc.pages.push({
        id: ids.get(key)!,
        name: r.name || '页面',
        children: [],
        background: rgb(r.backgroundColor || { r: 1, g: 1, b: 1 }),
      })
      continue
    }
    const kind = (
      {
        FRAME: 'frame',
        GROUP: 'group',
        RECTANGLE: 'rectangle',
        ROUNDED_RECTANGLE: 'rectangle',
        ELLIPSE: 'ellipse',
        LINE: 'line',
        VECTOR: 'vector',
        BOOLEAN_OPERATION: 'vector',
        REGULAR_POLYGON: 'polygon',
        STAR: 'star',
        TEXT: 'text',
        SYMBOL: 'frame',
        INSTANCE: 'frame',
        SECTION: 'section',
      } as Record<string, Parameters<typeof node>[0]>
    )[r.type]
    if (!kind) throw new Error(`FIG 节点类型 ${r.type} 暂不支持；原文件未修改`)
    const width = r.size?.x ?? 100, height = r.size?.y ?? 100
    if (![width, height].every((v) => Number.isFinite(v) && v >= 0 && v <= 1e7))
      throw new Error('FIG 图层尺寸无效；原文件未修改')
    const zeroLine = kind === 'line' && (width === 0 || height === 0) && (width > 0 || height > 0)
    if (!zeroLine && (width < 0.01 || height < 0.01))
      throw new Error('FIG 图层尺寸暂不能无损表达；原文件未修改')
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
    n.name = r.name || r.type
    n.transform = matrix(r.transform)
    n.visible = r.visible !== false
    n.locked = !!r.locked
    n.opacity = r.opacity ?? 1
    n.blend = String(r.blendMode || 'NORMAL')
      .toLowerCase()
      .replaceAll('_', '-') as typeof n.blend
    n.mask = !!r.mask
    n.maskType = r.maskType === 'LUMINANCE' ? 'luminance' : 'alpha'
    n.clip = kind === 'frame' && !r.frameMaskDisabled
    if (kind === 'polygon' || kind === 'star') n.points = r.count ?? n.points
    if (kind === 'star') n.innerRadius = r.starInnerScale ?? n.innerRadius
    n.fills = (r.fillPaints || r.backgroundPaints || []).map(toPaint)
    let strokeWidth = r.strokeWeight ?? 1
    if (r.borderStrokeWeightsIndependent && r.strokePaints?.length) {
      const borders = [r.borderTopWeight, r.borderRightWeight, r.borderBottomWeight, r.borderLeftWeight]
        .map((value) => value ?? strokeWidth)
      if (!borders.every((value) => value === borders[0]))
        throw new Error('FIG 独立非均匀边描边暂不能无损导入；原文件未修改')
      strokeWidth = borders[0]
    }
    const dash: unknown = r.dashPattern ?? []
    if (!Array.isArray(dash) || dash.some((value) => !Number.isFinite(value) || value < 0) ||
      (dash.length > 0 && dash.every((value) => value === 0)))
      throw new Error('FIG 虚线参数暂不能无损表达；原文件未修改')
    n.strokes = (r.strokePaints || []).map((p: any) => ({
      ...stroke(),
      paint: toPaint(p),
      width: strokeWidth,
      dash: dash.join(' '),
      align: String(r.strokeAlign || 'CENTER').toLowerCase(),
      cap: String(r.strokeCap || 'BUTT').toLowerCase(),
      join: String(r.strokeJoin || 'MITER').toLowerCase(),
    }))
    n.radii = [
      r.rectangleTopLeftCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleTopRightCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleBottomRightCornerRadius ?? r.cornerRadius ?? 0,
      r.rectangleBottomLeftCornerRadius ?? r.cornerRadius ?? 0,
    ]
    n.smoothing = r.cornerSmoothing || 0
    n.effects = (r.effects || []).map((x: any) => {
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
        color: rgb(x.color),
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
      }
    })
    if (r.vectorData?.vectorNetworkBlob !== undefined)
      warnings.add('矢量网络已保留，区域填充规则与区域样式需要核对')
    if (r.vectorData?.vectorNetworkBlob !== undefined)
      n.network = vectorBlob(getBlob(r.vectorData.vectorNetworkBlob))
    if (kind === 'text') {
      n.text = r.textData?.characters || ''
      n.fontSize = r.fontSize || 16
      n.textStyle = {
        ...defaultTextStyle(),
        wrap: true,
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
      const importedFonts=importFigTextRuns(n,r,warnings)
      if (importedFonts.style || Object.keys(importedFonts.runs).length) {
        doc.designSystem ??= emptySystem()
        doc.designSystem.fontSources ??= {}
        doc.designSystem.fontSources[n.id] = importedFonts
        warnings.add(
          `字体 ${r.fontName?.family || importedFonts.style || '片段字体'} 尚需匹配，已保留文字内容`,
        )
      }
    }
    if (r.type === 'SYMBOL') n.component = { variants: {}, properties: {} }
    if (r.type === 'INSTANCE') {
      const definition = ids.get(guid(r.symbolData?.symbolID))
      if (definition) {
        n.instance = { componentId: definition, overrides: {}, propertyValues: {} }
        if (r.symbolData?.symbolOverrides?.length)
          warnings.add('实例覆盖需要检查，已按主组件重新解析')
      } else warnings.add('外部实例缺少主组件，保留为普通画板')
    }
    if (r.type === 'BOOLEAN_OPERATION') n.network = { vertices: [], edges: [], fillRule: 'evenodd' }
    if (r.type === 'BOOLEAN_OPERATION')
      n.booleanOperation =
        (
          {
            UNION: 'union',
            SUBTRACT: 'subtract',
            INTERSECT: 'intersect',
            EXCLUDE: 'exclude',
          } as const
        )[r.booleanOperation as 'UNION'] || 'union'
    importLayout(n, r, records.get(guid(r.parentIndex?.guid)))
    doc.nodes[n.id] = n
  }
  // Figma's fractional positions are lexicographic identifiers. Locale collation
  // changes punctuation ordering (for example '-' before '!') and rearranges
  // children, which changes stacking as well as auto-layout placement.
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
  if (!doc.pages.length) throw new Error('FIG 文件没有可导入页面')
  if (
    [...records.values()].some(
      (r) => r.prototypeInteractions || r.componentPropDefs || r.boundVariables,
    )
  )
    warnings.add('原型、变量与部分组件属性尚需手动核对')
  doc.schemaVersion = Object.values(doc.nodes).some((n) =>
    n.effects.some((e) => e.glass || e.texture),
  )
    ? 5
    : 4
  if (Object.values(doc.nodes).some(n=>[...n.fills,...n.strokes.map(s=>s.paint)].some(p=>p.adjust))) doc.schemaVersion = 13
  if (Object.values(doc.nodes).some(n=>(n.textStyle?.textCase && n.textStyle.textCase !== 'original') || n.textRuns?.some(r=>r.textCase !== undefined))) doc.schemaVersion = 15
  return { document: doc, ...warnings.result() }
}
