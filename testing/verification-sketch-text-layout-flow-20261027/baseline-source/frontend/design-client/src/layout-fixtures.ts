import { blank, node, paint, defaultLayout, defaultSizing, type DesignDocument } from './model'
export type LayoutExample = 'horizontal' | 'wrap' | 'grid' | 'constraints' | 'text'
export function layoutFixture(kind: LayoutExample) {
  const doc = blank(`布局测试 · ${kind}`),
    p = node('frame', 20, 20, 300, 120)
  p.name = '容器'
  doc.nodes[p.id] = p
  doc.pages[0].children = [p.id]
  if (kind !== 'constraints') p.layout = defaultLayout()
  const add = (name: string, w: number, h: number, color: string) => {
    const n = node('rectangle', 0, 0, w, h)
    n.name = name
    n.fills = [paint(color)]
    doc.nodes[n.id] = n
    p.children.push(n.id)
    return n
  }
  if (kind === 'horizontal') {
    const a = add('固定项目', 60, 32, '#ef9478')
    const b = add('填满项目', 100, 32, '#8f82cf')
    b.sizing = { ...defaultSizing(), width: 'fill', height: 'fill' }
    p.layout!.align = 'center'
  }
  if (kind === 'wrap') {
    p.width = 240
    p.sizing = { ...defaultSizing(), height: 'hug' }
    p.layout!.wrap = true
    for (let i = 0; i < 5; i++) add(`项目 ${i + 1}`, 90, 30, i % 2 ? '#8f82cf' : '#ef9478')
  }
  if (kind === 'grid') {
    p.width = 360
    p.height = 220
    p.layout = { ...defaultLayout(), mode: 'grid', columns: 3, fillRows: true }
    for (let i = 0; i < 5; i++) {
      const n = add(`网格 ${i + 1}`, 40, 35, i % 2 ? '#8f82cf' : '#ef9478')
      n.sizing = {
        ...defaultSizing(),
        width: 'fill',
        height: 'fill',
        columnSpan: i === 0 ? 2 : 1,
        rowSpan: i === 0 ? 2 : 1,
      }
    }
  }
  if (kind === 'constraints') {
    p.height = 150
    const a = add('右下锚定', 50, 30, '#8f82cf')
    a.transform = [1, 0, 0, 1, 200, 80]
    a.constraints = {
      horizontal: 'end',
      vertical: 'end',
      referenceWidth: 300,
      referenceHeight: 150,
    }
    const b = add('水平拉伸', 80, 20, '#ef9478')
    b.transform = [1, 0, 0, 1, 20, 20]
    b.constraints = {
      horizontal: 'stretch',
      vertical: 'center',
      referenceWidth: 300,
      referenceHeight: 150,
    }
  }
  if (kind === 'text') {
    p.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
    const n = add('文字', 80, 32, '#34344f')
    n.kind = 'text'
    n.text = '自研布局'
    n.fontSize = 24
    n.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  }
  return doc
}
export function named(doc: DesignDocument, name: string) {
  const n = Object.values(doc.nodes).find((n) => n.name === name)
  if (!n) throw new Error(`Missing fixture node ${name}`)
  return n
}
