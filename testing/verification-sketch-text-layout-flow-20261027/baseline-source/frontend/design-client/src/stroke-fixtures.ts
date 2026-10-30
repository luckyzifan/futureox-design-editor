import { blank, node, stroke, paint, type DesignDocument, type DesignNode } from './model'
import { profilePreset } from './stroke-profile'
export function strokeFixture(): { doc: DesignDocument; ids: string[] } {
  const doc = blank('可变宽度 · 自研矢量内核'),
    ids: string[] = []
  const add = (n: DesignNode) => {
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
    ids.push(n.id)
    return n
  }
  const curve = add(node('vector', 60, 70, 290, 100))
  curve.name = '可拖拽宽度的贝塞尔曲线'
  curve.fills = []
  curve.network = {
    fillRule: 'nonzero',
    vertices: [
      { id: 'a', x: 0, y: 70 },
      { id: 'b', x: 280, y: 40 },
    ],
    edges: [{ id: 'ab', from: 'a', to: 'b', c1: { x: 80, y: -90 }, c2: { x: 190, y: 200 } }],
  }
  curve.strokes = [{ ...stroke('#744dcc', 38), widthProfile: profilePreset('spindle', false) }]
  const dashed = add(node('line', 55, 230, 300, 1))
  dashed.name = '保留连续宽度的虚线'
  dashed.fills = []
  dashed.strokes = [
    {
      ...stroke('#d25481', 32),
      cap: 'butt',
      dash: '22 9',
      widthProfile: profilePreset('grow', false),
    },
  ]
  const asymmetric = add(node('vector', 60, 310, 280, 1))
  asymmetric.name = '左右独立宽度'
  asymmetric.network = {
    fillRule: 'nonzero',
    vertices: [
      { id: 'c', x: 0, y: 0 },
      { id: 'd', x: 280, y: 0 },
    ],
    edges: [{ id: 'cd', from: 'c', to: 'd' }],
  }
  asymmetric.fills = []
  asymmetric.strokes = [
    { ...stroke('#168d85', 50), widthProfile: profilePreset('one-side', false) },
  ]
  const ring = add(node('ellipse', 440, 90, 160, 160))
  ring.name = '闭合路径周期接缝'
  ring.fills = [paint('#f0ebfc')]
  ring.strokes = [{ ...stroke('#d89b21', 18), widthProfile: profilePreset('wave', true) }]
  const transformed = add(node('rectangle', 455, 325, 95, 60))
  transformed.name = '反射、剪切与外描边'
  transformed.fills = [paint('#f7deed')]
  transformed.transform = [-1, 0.25, 0.4, 1.1, 575, 290]
  transformed.strokes = [
    {
      ...stroke('#394c8a', 12),
      align: 'outside',
      join: 'miter',
      widthProfile: profilePreset('wave', true),
    },
  ]
  return { doc, ids }
}
