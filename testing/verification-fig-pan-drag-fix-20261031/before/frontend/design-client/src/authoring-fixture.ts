import { blank, node, paint } from './model'
export function authoringFixture() {
  const doc = blank('七项能力验收')
  doc.schemaVersion = 4
  doc.rasterProfile = 'figma'
  const text = node('text', 20, 25, 300, 80)
  text.text = '中文 Mixed text'
  text.fontSize = 28
  text.textRuns = [
    { start: 0, end: 2, color: '#cc2233', underline: true },
    { start: 3, end: 8, fontSize: 36, strikethrough: true },
  ]
  const a = node('rectangle', 20, 140, 110, 100)
  a.name = '角度渐变'
  a.fills = [paint('#7755dd', 'angular')]
  const b = node('rectangle', 160, 140, 110, 100)
  b.name = '菱形渐变'
  b.fills = [{ ...paint('#77cc33', 'diamond'), transform: [1, 0.15, 0, 1, 0, 0] }]
  const group = node('group', 300, 140, 110, 100)
  group.fills = []
  const mask = node('rectangle', 0, 0, 110, 100)
  mask.mask = true
  mask.maskType = 'luminance'
  mask.fills = [paint('#ff0000')]
  const content = node('rectangle', 0, 0, 110, 100)
  content.fills = [paint('#ffffff')]
  group.children = [mask.id, content.id]
  for (const n of [text, a, b, group, mask, content]) doc.nodes[n.id] = n
  doc.pages[0].children = [text.id, a.id, b.id, group.id]
  const boolean = node('vector', 325, 20, 110, 80),
    left = node('ellipse', 0, 0, 70, 70),
    right = node('ellipse', 35, 0, 70, 70)
  boolean.name = '曲线布尔'
  boolean.booleanOperation = 'subtract'
  boolean.network = { vertices: [], edges: [], fillRule: 'evenodd' }
  boolean.children = [left.id, right.id]
  for (const n of [boolean, left, right]) doc.nodes[n.id] = n
  doc.pages[0].children.push(boolean.id)
  return { doc, textId: text.id }
}
