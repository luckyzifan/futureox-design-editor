import { blank, uid, type DesignDocument } from './model'
import { freehandNode, defaultBrush, type FreehandSample } from './freehand'
export function freehandFixture(): DesignDocument {
  const d = blank('自研铅笔 · 贝塞尔与笔压')
  const add = (samples: FreehandSample[], width: number, color: string) => {
    const n = freehandNode(uid(), samples, { ...defaultBrush(), width, color }, 1)
    d.nodes[n.id] = n
    d.pages[0].children.push(n.id)
  }
  add(
    Array.from({ length: 300 }, (_, i) => ({
      x: 45 + i,
      y: 90 + 38 * Math.sin(i / 45),
      pressure: 0.05 + 0.8 * Math.sin((Math.PI * i) / 299) ** 2,
    })),
    32,
    '#7555ca',
  )
  add(
    Array.from({ length: 240 }, (_, i) => {
      const t = (i / 239) * Math.PI * 2.5
      return {
        x: 450 + Math.cos(t) * (20 + i * 0.3),
        y: 150 + Math.sin(t) * (20 + i * 0.3),
        pressure: 0.15 + (0.65 * i) / 239,
      }
    }),
    17,
    '#168e83',
  )
  add(
    [
      { x: 55, y: 240, pressure: 0.5 },
      { x: 130, y: 295, pressure: 0.9 },
      { x: 220, y: 250, pressure: 0.3 },
      { x: 335, y: 300, pressure: 0.6 },
    ],
    22,
    '#cd5180',
  )
  add(
    [
      { x: 440, y: 310, pressure: 0.65 },
      { x: 440, y: 310, pressure: 0.9 },
    ],
    30,
    '#d8a022',
  )
  return d
}
