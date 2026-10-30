import { blank, node, paint, effect } from './model'
import { defaultColorSettings } from './color'
export function colorFixture(images: Record<string, string> = {}) {
  const doc = blank('广色域与 HDR 线性光验收')
  doc.schemaVersion = 3
  doc.rasterProfile = 'figma'
  doc.colorManagement = defaultColorSettings()
  doc.pages[0].background = '#000000'
  const add = (n: ReturnType<typeof node>) => {
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
    return n
  }
  for (const [i, color] of [
    'color(srgb-linear 4 0 0)',
    'color(display-p3 0 1 0)',
    'color(rec2100-pq 0.75 0.75 0.75)',
  ].entries()) {
    const n = add(node('rectangle', 16 + i * 96, 16, 72, 56))
    n.name = ['红通道 4×参考白', 'Display P3 绿色', 'PQ 高光'][i]
    n.fills = [paint(color)]
  }
  const gradient = add(node('rectangle', 16, 96, 168, 48))
  gradient.fills = [
    {
      ...paint('color(srgb-linear 4 0 0)', 'linear'),
      angle: 0,
      stops: [
        { offset: 0, color: 'color(srgb-linear 4 0 0 / 0.8)' },
        { offset: 1, color: 'color(display-p3 0 1 0 / 0.3)' },
      ],
    },
  ]
  const glow = add(node('ellipse', 216, 92, 60, 52))
  glow.fills = [paint('color(srgb-linear 2 1 4)')]
  glow.effects = [{ ...effect('blur'), radius: 4.25 }]
  for (const [i, [name, image]] of Object.entries(images).entries()) {
    const n = add(node('rectangle', 224 + i * 28, 146, 24, 24))
    n.name = name
    n.fills = [{ ...paint('#ffffff', 'image'), image, fit: 'stretch' }]
  }
  return doc
}
