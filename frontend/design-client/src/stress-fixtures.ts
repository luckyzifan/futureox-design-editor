import { blank, node, paint, stroke, effect, type DesignDocument } from './model'
import { Editor } from './engine'

export function largeScene(count = 6000) {
  const doc = blank(`大画布 · ${count} 个形状`)
  const root = node('group', 2_000_000, -1_000_000, 100_000, Math.ceil(count / 100) * 1000)
  root.blend = 'pass-through'
  root.fills = []
  root.clip = false
  doc.nodes[root.id] = root
  doc.pages[0].children = [root.id]
  for (let i = 0; i < count; i++) {
    const n = node(i % 4 ? 'rectangle' : 'ellipse', (i % 100) * 1000, Math.floor(i / 100) * 1000, 720, 720)
    n.fills = [paint(i % 2 ? '#4477cc' : '#cc7744')]
    doc.nodes[n.id] = n
    root.children.push(n.id)
  }
  return doc
}
export function deepScene(depth = 40) {
  const doc = blank(`多层级 · ${depth} 层`)
  let children = doc.pages[0].children
  for (let i = 0; i < depth; i++) {
    const group = node(i % 8 === 0 ? 'frame' : 'group', 0.125, 0.125, 96, 80)
    group.blend = 'pass-through'
    group.fills = []
    group.opacity = i % 7 === 0 ? 0.875 : 1
    if (group.kind === 'frame') group.radii = [12, 12, 12, 12]
    children.push(group.id)
    doc.nodes[group.id] = group
    children = group.children
  }
  const a = node('ellipse', 5.125, 6.125, 64, 50)
  a.fills = [paint('#4477dd', 'linear')]
  a.strokes = [stroke('#223344', 1.25)]
  const b = node('rectangle', 32.125, 20.125, 52, 42)
  b.blend = 'screen'
  b.fills = [{ ...paint('#dd4477'), opacity: 0.65 }]
  b.effects = [{ ...effect('shadow'), radius: 2, x: 1, y: 1 }]
  for (const n of [a,b]) {doc.nodes[n.id] = n; children.push(n.id)}
  return doc
}
export function copiedScene(doc: DesignDocument) {
  const editor = new Editor(doc)
  editor.select(doc.pages[0].children)
  editor.copy()
  editor.paste()
  const all = editor.state.doc
  const nodes: DesignDocument['nodes'] = {}
  const visit = (id: string) => {nodes[id] = all.nodes[id]; nodes[id].children.forEach(visit)}
  editor.state.selection.forEach(visit)
  return { ...all, nodes, pages: [{ ...all.pages[0], children: [...editor.state.selection] }] }
}
export function rampScene() {
  const doc = blank('256 个灰阶')
  for (let i = 0; i < 256; i++) {
    const n = node('rectangle', i, 0, 1, 16)
    n.fills = [paint(`#${i.toString(16).padStart(2,'0').repeat(3)}`)]
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
  }
  return doc
}
