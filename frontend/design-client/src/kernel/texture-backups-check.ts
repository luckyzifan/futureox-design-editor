/** Fixed synthetic documents for VITE_DESIGN_TEXTURE_BACKUPS. Every frame goes through the
 * production KernelClient and worker. The page publishes the SHA-256 of the read back RGBA,
 * the draw count and the stage times; the runner pairs a default build with the candidate. */
import { KernelClient, type KernelOptions } from './client'
import { blank, node, paint, stroke, effect, type DesignDocument, type DesignNode, type Paint } from '../model'
import { defaultColorSettings } from '../color'

const output = document.querySelector<HTMLElement>('#results')!
const colors = ['#4477cc', '#cc7744', '#44aa77', '#cc4488', '#332244', '#e0c090', '#1070a0', '#a04030']
const solid = (color: string, opacity = 1): Paint => ({ ...paint(color), opacity })
const rectangle = (x: number, y: number, width: number, height: number, fill: Paint): DesignNode => {
  const shape = node('rectangle', x, y, width, height)
  shape.fills = [fill]
  return shape
}
const ellipse = (x: number, y: number, width: number, height: number, fill: Paint): DesignNode => {
  const shape = node('ellipse', x, y, width, height)
  shape.fills = [fill]
  return shape
}
/** A grid of separate top-level shapes; `color` is the shape's index modulo the palette. */
const grid = (count: number, columns: number, place: (column: number, row: number, color: number) => DesignNode) => {
  const document = blank('texture backups'), ids: string[] = []
  for (let index = 0; index < count; index++) {
    const column = index % columns, row = Math.floor(index / columns)
    const shape = place(column, row, index % colors.length)
    document.nodes[shape.id] = shape
    ids.push(shape.id)
  }
  document.pages[0].children = ids
  return document
}
const scenes: Record<string, () => DesignDocument> = {
  // Pixel-aligned opaque rectangles: the regional lane for every sample.
  'rect-int-400': () => grid(400, 20, (c, r, k) => rectangle(c * 25 + (c % 7 ? 0 : 3), r * 25, 20, 20, solid(colors[k]))),
  // Fractional edges need the destination at every edge sample.
  'rect-frac-400': () => grid(400, 20, (c, r, k) => rectangle(c * 25.3 + 0.3, r * 25.7 + 0.6, 19.4, 18.6, solid(colors[k]))),
  'ellipse-300': () => grid(300, 20, (c, r, k) => ellipse(c * 25.3 + 1.2, r * 25.7 + 2.4, 21.4, 18.6, solid(colors[k]))),
  // Overlapping translucent fills blend with the destination inside the rectangle too.
  'alpha-200': () => grid(200, 20, (c, r, k) => rectangle(c * 25 + (c % 3) * 4, r * 50 + (r % 5) * 3, 30, 30, solid(colors[k], 0.5))),
  // Strokes keep their own lane next to the solid fill.
  'stroke-200': () => grid(200, 20, (c, r, k) => {
    const shape = rectangle(c * 25.3 + 2.2, r * 50.4 + 3.1, 19.4, 42.6, solid(colors[k]))
    shape.strokes = [stroke(colors[(k + 3) % colors.length], k % 2 ? 2 : 0.75)]
    return shape
  }),
  // Isolated groups with opacity, clipping and one non-normal blend.
  'groups-400': () => {
    const document = blank('texture backups'), roots: string[] = []
    for (let g = 0; g < 10; g++) {
      const group = node('group', (g % 5) * 102.4, Math.floor(g / 5) * 256.3, 100, 250)
      group.fills = []
      group.opacity = g % 3 ? 1 : 0.8
      group.clip = g % 2 === 1
      group.blend = g % 4 === 2 ? 'multiply' : 'normal'
      document.nodes[group.id] = group
      roots.push(group.id)
      for (let i = 0; i < 40; i++) {
        const shape = rectangle(group.transform[4] + (i % 8) * 12.3, group.transform[5] + Math.floor(i / 8) * 48.6 + (i % 3), 14.2, 40.4, solid(colors[i % colors.length]))
        document.nodes[shape.id] = shape
        group.children.push(shape.id)
      }
    }
    document.pages[0].children = roots
    return document
  },
  'gradient-200': () => grid(200, 20, (c, r, k) => rectangle(c * 25.3 + 0.7, r * 50.2 + 1.1, 22.4, 44.6,
    { ...paint(colors[k], k % 2 ? 'linear' : 'radial'), stops: [{ offset: 0, color: colors[k] }, { offset: 1, color: colors[(k + 5) % colors.length] }] })),
  // Rectangles that cover most of the plane keep the whole-target pass.
  'big-40': () => grid(40, 8, (c, r, k) => rectangle(c * 37.3 - 20, r * 83.7 - 30, 210.4, 190.2, solid(colors[k], k % 4 ? 1 : 0.6))),
  'shadow-120': () => grid(120, 12, (c, r, k) => {
    const shape = rectangle(c * 42.3 + 3.3, r * 50.7 + 4.2, 28.4, 30.6, solid(colors[k]))
    shape.effects = [{ ...effect('shadow'), radius: 3, x: 2, y: 2 }]
    return shape
  }),
}
// The analytic profile is one managed plane; figma with colour management is four.
const modes: Record<string, { document: Partial<DesignDocument>; options: Pick<KernelOptions, 'rasterProfile'> }> = {
  analytic: { document: {}, options: { rasterProfile: 'analytic' } },
  figma: { document: {}, options: { rasterProfile: 'figma' } },
  'figma-srgb': { document: { schemaVersion: 3, rasterProfile: 'figma', colorManagement: defaultColorSettings() }, options: { rasterProfile: 'figma' } },
}

async function render(document: DesignDocument, options: Pick<KernelOptions, 'rasterProfile'>, zoom: number) {
  const client = new KernelClient()
  try {
    const result = await client.render(document, { pageId: document.pages[0].id, width: 512, height: 512,
      view: { x: 0, y: 0, zoom }, grid: false, transparent: false, renderIntent: 'canvas', ...options }, false, 'webgpu', true, false, { disableExactTileCache: true })
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes)))
    return { sha: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), draws: result.drawCalls,
      graphMs: Math.round(result.graphMs ?? 0), finishMs: Math.round(result.finishMs ?? 0) }
  } finally { client.dispose() }
}

try {
  const rows: unknown[] = []
  await render(scenes['rect-int-400'](), modes.analytic.options, 1)
  for (const zoom of [1, 2.5]) for (const [scene, make] of Object.entries(scenes)) for (const [mode, { document: patch, options }] of Object.entries(modes)) {
    const document = { ...make(), ...patch }
    rows.push({ scene, mode, zoom, ...await render(document, options, zoom) })
  }
  output.textContent = JSON.stringify({ rows })
} catch (error) { output.textContent = JSON.stringify({ error: String(error) }) }
