import { expect, test } from 'vitest'
import { blank, node, paint } from '../model'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { canvasRasterPlan, preservesNativePanPhase } from './canvas-raster-plan'

for (const zoom of [.293650625, 1, 32]) test(`real kernel analytic pixels preserve an eligible integer pan lattice at zoom ${zoom}`, () => {
  const doc = blank('Native pan pixel oracle')
  const rectangle = node('rectangle', 8 / zoom, 6 / zoom, 35 / zoom, 25 / zoom)
  rectangle.fills = [paint('#3377bb')]
  const ellipse = node('ellipse', 25 / zoom, 13 / zoom, 30 / zoom, 30 / zoom)
  ellipse.fills = [paint('#ee8844')]
  doc.nodes = { [rectangle.id]: rectangle, [ellipse.id]: ellipse }
  doc.pages[0].children = [rectangle.id, ellipse.id]
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(doc))
    const view = { x: .125, y: -.375, zoom }, dpr = 2
    const first = canvasRasterPlan(view, dpr, 96, 72, { exactPhase: true })
    const next = { ...view, x: view.x + 5 / dpr, y: view.y - 3 / dpr }
    const previous = { view, dpr, rasterScale: first.scale, samplingMode: first.mode }
    const moving = canvasRasterPlan(next, dpr, 96, 72, {
      exactPhase: preservesNativePanPhase(next, dpr, first.scale, false, previous),
    })
    const settled = canvasRasterPlan(next, dpr, 96, 72, { exactPhase: true })
    const render = (plan: typeof first) => kernel.render_rgba(JSON.stringify({
      pageId: doc.pages[0].id, width: 96, height: 72, view: plan.camera,
      transparent: false, rasterProfile: 'analytic',
    }))
    const before = render(first), after = render(moving)
    expect(after).toEqual(render(settled))
    const a: number[] = [], b: number[] = []
    for (let y = 3; y < 72; y++) for (let x = 0; x < 91; x++) for (let c = 0; c < 4; c++) {
      a.push(before[(y * 96 + x) * 4 + c])
      b.push(after[((y - 3) * 96 + x + 5) * 4 + c])
    }
    expect(b).toEqual(a)
  } finally { kernel.free() }
})
