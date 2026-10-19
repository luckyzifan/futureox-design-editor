import {codeFontResource} from './tool-activation'
import {
  node,
  paint,
  stroke,
  defaultLayout,
  defaultSizing,
  defaultTextStyle,
  type DesignNode,
  type DesignDocument,
  type Point,
  type Bounds,
} from './model'
import type { Editor } from './engine'
export const boardToolNames = {
  sticky: '便签',
  table: '表格',
  'code-block': '代码块',
  'shape-whiteboard-square': '白板矩形',
  'shape-whiteboard-ellipse': '白板椭圆',
  'shape-whiteboard-rounded-rectangle': '白板圆角矩形',
  'shape-whiteboard-triangle-up': '白板上三角',
  'shape-whiteboard-triangle-down': '白板下三角',
  'shape-whiteboard-diamond': '白板菱形',
  'connector-straight': '直线连接器',
  'connector-elbowed': '折线连接器',
  'sites-responsive-set': '响应式套件',
} as const
export type BoardTool = keyof typeof boardToolNames
function label(text: string, width: number, height: number, size = 20) {
  const n = node('text', 16, 16, Math.max(1, width - 32), Math.max(1, height - 32))
  n.text = text
  n.fontSize = size
  n.textStyle = { ...defaultTextStyle(), wrap: true }
  n.fills = [paint('#242424')]
  n.strokes = []
  return n
}
function cell(row: number, column: number, width: number, height: number) {
  const frame = node('frame', 0, 0, width, height),
    text = label('', width, height, 16)
  frame.name = `单元格 ${row + 1},${column + 1}`
  frame.fills = [paint('#ffffff')]
  frame.strokes = [stroke('#d4d4d4', 1)]
  frame.children = [text.id]
  frame.sizing = { ...defaultSizing(), width: 'fill' }
  text.constraints = {
    horizontal: 'stretch',
    vertical: 'stretch',
    referenceWidth: width,
    referenceHeight: height,
  }
  return [frame, text]
}
/** Whiteboard tools author ordinary editable shapes/text, rendered by the same Rust kernel. */
export function boardObjects(tool: BoardTool, box: Bounds): { root: string; nodes: DesignNode[];fonts?:DesignDocument['fonts'] } {
  const { x, y } = box,
    width = Math.max(40, box.width),
    height = Math.max(40, box.height)
  const root = node('frame', x, y, width, height),
    nodes = [root]
  root.clip = false
  root.board = { kind: tool }
  root.name = boardToolNames[tool]
  if (tool === 'table') {
    root.board = { kind: tool, rows: 3, columns: 3 }
    root.fills = []
    root.layout = { ...defaultLayout(), mode: 'grid', columns: 3, gap: 0, lineGap: 0, padding: [0, 0, 0, 0] }
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) {
        const children = cell(row, col, width / 3, height / 3)
        root.children.push(children[0].id)
        nodes.push(...children)
      }
  } else if (tool === 'sites-responsive-set') {
    root.fills = []
    root.width = 1280 + 768 + 390 + 96
    root.height = 800
    root.layout = { ...defaultLayout(), mode: 'horizontal', gap: 48, padding: [0, 0, 0, 0] }
    for (const [name, w] of [
      ['桌面', 1280],
      ['平板', 768],
      ['手机', 390],
    ] as const) {
      const f = node('frame', 0, 0, w, 800)
      f.name = name
      f.fills = [paint('#ffffff')]
      f.layout = { ...defaultLayout(), mode: 'vertical' }
      nodes.push(f)
      root.children.push(f.id)
    }
  } else if (tool === 'sticky' || tool === 'code-block') {
    root.fills = [paint(tool === 'sticky' ? '#fff3a3' : '#24292f')]
    root.radii = tool === 'sticky' ? [0, 0, 0, 0] : [8, 8, 8, 8]
    const text = label(
      tool === 'sticky' ? '写下想法' : '// 在这里编写代码',
      width,
      height,
      tool === 'sticky' ? 24 : 16,
    )
    if (tool === 'code-block') text.fills = [paint('#e6edf3')]
    root.children = [text.id]
    nodes.push(text)
  } else {
    root.kind = 'group'
    root.fills = []
    const kind = tool.endsWith('ellipse')
      ? 'ellipse'
      : tool.includes('triangle') || tool.endsWith('diamond')
        ? 'polygon'
        : 'rectangle'
    const shape = node(kind, 0, 0, width, height)
    shape.fills = [paint('#dce9ff')]
    shape.strokes = [stroke('#426699', 2)]
    if (tool.includes('rounded')) shape.radii = [12, 12, 12, 12]
    if (tool.endsWith('diamond')) {
      shape.points = 4
      shape.transform = [1, 0, 0, 1, 0, 0]
    }
    if (tool.endsWith('triangle-down')) shape.transform = [-1, 0, 0, -1, width, height]
    const text = label('', width, height)
    text.textStyle = { ...defaultTextStyle(), align: 'center', wrap: true }
    root.children = [shape.id, text.id]
    nodes.push(shape, text)
  }
  if(tool==='code-block'){
    const font=codeFontResource();root.board={kind:tool,language:'javascript'};root.clip=true
    const text=nodes.find(n=>n.kind==='text')!;text.textStyle={...defaultTextStyle(),fontId:font.id,fallbacks:['default'],wrap:false}
    return {root:root.id,nodes,fonts:{[font.id]:font.resource}}
  }
  return { root: root.id, nodes }
}
export function resizeTable(editor: Editor, id: string, rows: number, columns: number) {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows > 50 ||
    columns > 30 ||
    rows * columns > 600
  )
    throw new Error('表格最多50行、30列、600个单元格')
  editor.change(
    '修改表格行列',
    (doc) => {
      const root = doc.nodes[id],
        oldRows = root.board?.rows || 3,
        oldCols = root.board?.columns || 3,
        children = [...root.children],
        next: string[] = []
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < columns; c++) {
          if (r < oldRows && c < oldCols) next.push(children[r * oldCols + c])
          else {
            const added = cell(r, c, root.width / columns, root.height / rows)
            for (const n of added) doc.nodes[n.id] = n
            next.push(added[0].id)
          }
        }
      const remove = (id: string) => {
        doc.nodes[id]?.children.forEach(remove)
        delete doc.nodes[id]
      }
      children.filter((id) => !next.includes(id)).forEach(remove)
      root.children = next
      root.board = { kind: 'table', rows, columns }
      root.layout = { ...defaultLayout(), ...root.layout, mode: 'grid', columns }
      for (const id of next) {
        doc.nodes[id].width = root.width / columns
        doc.nodes[id].height = root.height / rows
      }
    },
    [id],
  )
}

export function resizeBoardObjects(source: ReturnType<typeof boardObjects>, box: Bounds) {
  const result = {...source,nodes:structuredClone(source.nodes)},
    root = result.nodes.find((n) => n.id === result.root)!,
    oldWidth = root.width,
    oldHeight = root.height
  if (root.board?.kind === 'sites-responsive-set') {
    root.transform = [1, 0, 0, 1, box.x, box.y]
    return result
  }
  root.transform = [1, 0, 0, 1, box.x, box.y]
  root.width = Math.max(40, box.width)
  root.height = Math.max(40, box.height)
  const sx = root.width / oldWidth,
    sy = root.height / oldHeight
  for (const n of result.nodes) {
    if (n.id === root.id) continue
    n.transform[4] *= sx
    n.transform[5] *= sy
    n.width = Math.max(1, n.width * sx)
    n.height = Math.max(1, n.height * sy)
    if (n.constraints) {
      n.constraints.referenceWidth = (n.constraints.referenceWidth || oldWidth) * sx
      n.constraints.referenceHeight = (n.constraints.referenceHeight || oldHeight) * sy
    }
  }
  return result
}
