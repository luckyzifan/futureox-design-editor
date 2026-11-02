import type { ImportWarningSink } from './import-warnings'
import { emptySystem } from './design-system'
import type { ConnectorEndpoint, DesignDocument, DesignNode, Kind } from './model'

/** Kiwi node types with the same kernel kind as `fig.rs` `KNOWN_KINDS`.
 * Unknown names are rejected. Lossy stand-ins keep geometry and say so. */
const FIG_KINDS: Record<string, Kind> = {
  FRAME: 'frame',
  GROUP: 'group',
  BOOLEAN_OPERATION: 'vector',
  VECTOR: 'vector',
  LINE: 'line',
  ELLIPSE: 'ellipse',
  RECTANGLE: 'rectangle',
  ROUNDED_RECTANGLE: 'rectangle',
  REGULAR_POLYGON: 'polygon',
  STAR: 'star',
  TEXT: 'text',
  SLICE: 'slice',
  SECTION: 'section',
  SYMBOL: 'frame',
  INSTANCE: 'frame',
  STICKY: 'frame',
  CODE_BLOCK: 'group',
  CONNECTOR: 'vector',
  TABLE_CELL: 'text',
  SHAPE_WITH_TEXT: 'group',
  TABLE: 'frame',
  EMBED: 'frame',
  MEDIA: 'frame',
  GIF: 'frame',
  VIDEO: 'frame',
  HOTSPOT: 'frame',
  ANNOTATION: 'text',
  HIGHLIGHT: 'rectangle',
  WASHI_TAPE: 'rectangle',
  LIKE: 'ellipse',
  MARK: 'ellipse',
  STAMP: 'group',
  SHAPE_WITH_NODES: 'group',
  CODE_SANDBOX: 'frame',
  COMPONENT_SET: 'frame',
  MINI_MAP: 'frame',
}
const LOSSY_STAND_IN = new Set([
  'EMBED', 'MEDIA', 'GIF', 'VIDEO', 'HOTSPOT', 'HIGHLIGHT', 'WASHI_TAPE', 'LIKE', 'MARK',
  'STAMP', 'SHAPE_WITH_NODES', 'CODE_SANDBOX', 'MINI_MAP', 'COMPONENT_SET', 'ANNOTATION',
])
const WHITEBOARD_SHAPES: Record<string, string> = {
  SQUARE: 'shape-whiteboard-square',
  ELLIPSE: 'shape-whiteboard-ellipse',
  DIAMOND: 'shape-whiteboard-diamond',
  TRIANGLE_UP: 'shape-whiteboard-triangle-up',
  TRIANGLE_DOWN: 'shape-whiteboard-triangle-down',
  ROUNDED_RECTANGLE: 'shape-whiteboard-rounded-rectangle',
}
const CODE_LANGUAGES: Record<string, string> = {
  JAVASCRIPT: 'javascript',
  TYPESCRIPT: 'typescript',
  JSON: 'json',
  PYTHON: 'python',
  RUST: 'rust',
  PLAINTEXT: 'plain',
}

export type FigReceipts = Map<string, Record<string, string>>

const sourceGuid = (g: any) => (typeof g === 'string' ? g : g ? `${g.sessionID}:${g.localID}` : '')
const entryCount = (record: any, field: string) => {
  const entries = record?.[field]?.entries
  return Array.isArray(entries) ? entries.length : 0
}

/** Append one rust-compatible receipt. These move to inert node metadata, not variable bindings. */
export function figNote(receipts: FigReceipts, id: string, message: string) {
  const bindings = receipts.get(id) ?? {}
  const notes: string[] = bindings.figUntranslated ? JSON.parse(bindings.figUntranslated) : []
  if (!notes.includes(message)) notes.push(message)
  bindings.figUntranslated = JSON.stringify(notes)
  receipts.set(id, bindings)
}

export function figNodeKind(record: any, warnings: ImportWarningSink): Kind {
  const type = String(record?.type ?? '')
  if (type === 'SHAPE_WITH_TEXT' && !Object.hasOwn(WHITEBOARD_SHAPES, String(record.shapeWithTextType))) {
    throw new Error(`FIG 节点类型 SHAPE_WITH_TEXT(shapeWithTextType=${record.shapeWithTextType ?? '?'}) 暂不支持；原文件未修改`)
  }
  if (type === 'TABLE') {
    const rows = entryCount(record, 'tableRowHeights')
    const columns = entryCount(record, 'tableColumnWidths')
    if (rows === 0 || columns === 0 || rows > 50 || columns > 30 || rows * columns > 600) {
      throw new Error(`FIG 节点类型 TABLE(${rows}x${columns} exceeds kernel budget) 暂不支持；原文件未修改`)
    }
  }
  const kind = FIG_KINDS[type]
  if (!kind) throw new Error(`FIG 节点类型 ${type} 暂不支持；原文件未修改`)
  if (LOSSY_STAND_IN.has(type)) warnings.add(`FIG 节点 ${type} 已按可编辑图层导入，其专用内容尚未执行`)
  return kind
}

function finitePoint(value: unknown, label: string) {
  const n = typeof value === 'number' ? value : 0
  if (!Number.isFinite(n) || Math.abs(n) > 1e7) throw new Error(`FIG 连接线${label}无效；原文件未修改`)
  return n
}

function connectorEndpoint(value: any, resolveId: (guid: any) => string | undefined, notes: string[]): ConnectorEndpoint {
  // A missing endpoint floats at the origin. A present endpoint with AUTO/NONE
  // still needs an anchor, so it degrades to center and records the substitution.
  if (!value) return { point: { x: 0, y: 0 } }
  const magnet = value.magnet ?? 'AUTO'
  const exact: Record<string, [number, number]> = {
    TOP: [0.5, 0],
    BOTTOM: [0.5, 1],
    LEFT: [0, 0.5],
    RIGHT: [1, 0.5],
    CENTER: [0.5, 0.5],
  }
  const known = exact[magnet]
  if (!known) notes.push(`connectorMagnet=${magnet}->center`)
  const anchor = known ?? [0.5, 0.5]
  const source = value.endpointNodeID
  const nodeId = source ? resolveId(source) : undefined
  if (source && !nodeId) throw new Error('FIG 连接线端点缺少目标图层；原文件未修改')
  return {
    point: { x: finitePoint(value.position?.x, '坐标'), y: finitePoint(value.position?.y, '坐标') },
    ...(nodeId ? { nodeId } : {}),
    anchor: { x: anchor[0], y: anchor[1] },
  }
}

/** Board, connector and table payloads. Checks match the native reader. */
export function applyFigFacet(
  node: DesignNode,
  record: any,
  resolveId: (guid: any) => string | undefined,
  receipts: FigReceipts,
  warnings: ImportWarningSink,
) {
  if (record.type === 'STICKY') node.board = { kind: 'sticky' }
  if (record.type === 'CODE_BLOCK') {
    const language = record.codeBlockLanguage
    const mapped = typeof language === 'string' ? CODE_LANGUAGES[language] : undefined
    if (typeof language === 'string' && !mapped) {
      figNote(receipts, node.id, `codeBlockLanguage=${language}`)
      warnings.add(`FIG 代码语言 ${language} 已按纯文本保留`)
    }
    node.board = { kind: 'code-block', ...(mapped ? { language: mapped } : {}) }
  }
  if (record.type === 'SHAPE_WITH_TEXT') {
    node.board = { kind: WHITEBOARD_SHAPES[record.shapeWithTextType] }
  }
  if (record.type === 'TABLE') {
    node.board = {
      kind: 'table',
      rows: entryCount(record, 'tableRowHeights'),
      columns: entryCount(record, 'tableColumnWidths'),
    }
  }
  if (record.type === 'CONNECTOR') {
    const notes: string[] = []
    const style = record.connectorLineStyle
    let mapped: 'straight' | 'elbow' = 'straight'
    if (style === 'ELBOWED') mapped = 'elbow'
    else if (style === 'CURVED') {
      notes.push('connectorLineStyle=CURVED')
      warnings.add('FIG 曲线连接线已按直线连接保留')
    } else if (style !== undefined && style !== 'STRAIGHT') {
      notes.push(`connectorLineStyle=${style}`)
      warnings.add(`FIG 连接线样式 ${style} 已按直线保留`)
    }
    node.connector = {
      from: connectorEndpoint(record.connectorStart, resolveId, notes),
      to: connectorEndpoint(record.connectorEnd, resolveId, notes),
      style: mapped,
    }
    for (const message of notes) {
      figNote(receipts, node.id, message)
      if (message.startsWith('connectorMagnet=')) warnings.add(`FIG 连接线端点 ${message} 已按中心锚点近似`)
    }
  }
}

export function assertFigStructure(doc: DesignDocument) {
  for (const n of Object.values(doc.nodes)) {
    if (n.kind === 'slice' && (n.fills.length || n.strokes.length || n.effects.length || n.children.length || n.network || n.vectorGeometry || n.mask)) {
      throw new Error(`FIG 切片「${n.name}」包含绘制内容，暂不能无损导入；原文件未修改`)
    }
    if (n.connector && n.children.length) throw new Error(`FIG 连接线「${n.name}」不能包含子图层；原文件未修改`)
  }
}

/** Non-executable prototype receipts. The same JSON shape as the native reader. */
export function importFigPrototype(records: Map<string, any>, ids: Map<string, string>, doc: DesignDocument, receipts: FigReceipts) {
  for (const [source, record] of records) {
    if (!Array.isArray(record.prototypeInteractions)) continue
    const id = ids.get(source)
    if (!id || !doc.nodes[id]) continue
    const flows: Array<Record<string, unknown>> = []
    for (const interaction of record.prototypeInteractions) {
      if (interaction?.isDeleted) continue
      const trigger = interaction?.event?.interactionType ?? 'ON_CLICK'
      const actions = Array.isArray(interaction?.actions) ? interaction.actions : []
      for (const action of actions) {
        const destination = action?.transitionNodeID
        flows.push({
          trigger,
          destinationId: destination ? (ids.get(sourceGuid(destination)) ?? sourceGuid(destination)) : null,
          navigation: action?.navigationType ?? null,
          transition: action?.transitionType ?? null,
          duration: typeof action?.transitionDuration === 'number' && Number.isFinite(action.transitionDuration) ? action.transitionDuration : null,
        })
      }
    }
    if (!flows.length) continue
    const bindings = receipts.get(id) ?? {}
    bindings.prototypeFlow = JSON.stringify(flows)
    receipts.set(id, bindings)
  }
}

export function parkFigReceipts(doc: DesignDocument, receipts: FigReceipts) {
  if (!receipts.size) return
  const nodeMetadata: Record<string, { format: 'fig'; bindings: Record<string, string> }> = {}
  for (const [id, bindings] of receipts) nodeMetadata[id] = { format: 'fig', bindings }
  const system = (doc.designSystem ??= emptySystem())
  system.sketchContainers = { ...system.sketchContainers, nodeMetadata }
}
