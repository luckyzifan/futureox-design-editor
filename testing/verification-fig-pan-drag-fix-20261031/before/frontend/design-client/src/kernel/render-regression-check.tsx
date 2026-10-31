import { createRoot } from 'react-dom/client'
import { blank, node, paint, effect, type DesignDocument } from '../model'
import { KernelClient, type TileResult } from './client'
import { KernelSurface, type PresentedFrame } from './Surface'
import { initializePicking } from './picking'
import { apply, multiply } from '../geometry'
import '../styles.css'

const output = document.getElementById('results')!, host = document.getElementById('canvas')!
const report: { status: string; stages: unknown[]; errors: string[] } = { status: 'running', stages: [], errors: [] }
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
const pixels = (tile: TileResult) => {
  const canvas = document.createElement('canvas'); canvas.width = tile.width; canvas.height = tile.height
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
  if (tile.bitmap) context.drawImage(tile.bitmap, 0, 0)
  else context.putImageData(new ImageData(new Uint8ClampedArray(tile.bytes), tile.width, tile.height), 0, 0)
  const data = context.getImageData(0, 0, tile.width, tile.height).data
  tile.bitmap?.close()
  return data
}

try {
  await initializePicking()
  const sample = blank('managed GPU presentation')
  sample.schemaVersion = 3
  sample.rasterProfile = 'figma'
  sample.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const shape = node('ellipse', 10.25, 12.75, 53.5, 41.25)
  shape.fills = [paint('#3975e8')]; shape.opacity = 0.7
  const shadow = effect('shadow'); shadow.radius = 3; shadow.x = 2; shadow.y = 2
  shape.effects = [shadow]; sample.nodes[shape.id] = shape; sample.pages[0].children = [shape.id]
  const client = new KernelClient()
  try {
    const options = { pageId: sample.pages[0].id, width: 96, height: 80,
      view: { x: 0.25, y: 0.5, zoom: 1 }, transparent: false, grid: false, rasterProfile: 'figma' as const,
      renderIntent: 'settled' as const,
      tileViewport: [{ key: 'presentation-probe', x: 0, y: 0, width: 96, height: 80, zoom: 1, phaseX: 0.25, phaseY: 0.5 }] }
    let reference: TileResult | undefined, presented: TileResult | undefined
    await client.render(sample, options, false, 'webgpu', true, false, { disableExactTileCache: true }, t => { reference = t })
    const result = await client.render(sample, options, false, 'webgpu', false, false, { disableExactTileCache: true }, t => { presented = t })
    assert(reference && presented?.bitmap, 'Managed SDR must produce a GPU bitmap')
    assert(presented!.bytes.length === 0 && !presented!.linear, 'Display path must not transfer CPU pixels')
    const a = pixels(reference!), b = pixels(presented!)
    let maxDifference = 0
    for (let i = 0; i < a.length; i++) maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]))
    assert(maxDifference <= 1, `GPU display conversion differs by ${maxDifference}/255`)
    report.stages.push({ name: 'managed bitmap vs exact readback', maxDifference, ms: result.roundTripMs,
      cpuPixelBytes: presented!.bytes.length }); publish()
  } finally { client.dispose() }

  let doc = sample
  if (new URLSearchParams(location.search).has('fixture')) {
    const response = await fetch('/__render_fixture')
    if (!response.ok) throw new Error('Local fixture unavailable')
    const input = await response.json()
    doc = (input.document || input) as DesignDocument
  }
  let width = 800, height = 520
  const root = createRoot(host)
  Object.assign(host.style, { position: 'relative', width: `${width}px`, height: `${height}px`, overflow: 'hidden' })
  let pending: { view: { x: number; y: number; zoom: number }; checkerboard?: boolean; resolve: () => void } | undefined
  const onPresentation = (frame: PresentedFrame | null) => {
    if (!pending || !frame || frame.preview || frame.view.x !== pending.view.x || frame.view.y !== pending.view.y || frame.view.zoom !== pending.view.zoom || !!frame.checkerboard !== !!pending.checkerboard) return
    const resolve = pending.resolve; pending = undefined; resolve()
  }
  const mainFrame = Object.values(doc.nodes).filter(n => n.kind === 'frame').sort((a, b) => b.width * b.height - a.width * a.height)[0]
  let center = { x: 32, y: 32 }
  if (mainFrame) {
    const parents = new Map(Object.values(doc.nodes).flatMap(n => n.children.map(child => [child, n] as const)))
    let transform = mainFrame.transform, parent = parents.get(mainFrame.id)
    while (parent) { transform = multiply(parent.transform, transform); parent = parents.get(parent.id) }
    center = apply(transform, { x: mainFrame.width / 2, y: mainFrame.height / 2 })
  }
  const present = async (view: {x:number;y:number;zoom:number}, checkerboard = false) => {
    const start = performance.now()
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Frame timed out: ${host.querySelector('.kernel-status')?.textContent}`)), 120_000)
      pending = { view, checkerboard, resolve: () => { clearTimeout(timer); resolve() } }
    })
    root.render(<KernelSurface document={doc} pageId={doc.pages[0].id} width={width} height={height}
      view={view} grid={false} checkerboard={checkerboard} presentationEpoch={1} onPresentation={onPresentation} />)
    await done
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const surface = host.querySelector<HTMLElement>('.kernel-tiles')!
    const exact = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-lod="exact"][data-frame-visible="true"]')]
      .filter(canvas => canvas.dataset.tileRevision === surface.dataset.revision)
    const compositor = host.querySelector<HTMLCanvasElement>('.kernel-compositor')
    assert(compositor || exact.length > 0, 'A ready frame needs a published display surface')
    if (compositor) {
      assert(host.querySelectorAll('.kernel-presentation canvas').length === 1, 'SDR display must use one GPU canvas')
      assert(Number(surface.dataset.samplingDensity) + 1e-8 >= devicePixelRatio, 'Settled texture density is below screen density')
      assert(compositor.width === Math.ceil(width * devicePixelRatio), 'Single canvas backing density')
    }
    for (const canvas of exact) {
      const density = canvas.width / Number.parseFloat(canvas.style.width)
      assert(density + 1e-8 >= devicePixelRatio, 'Settled display must never upscale below physical screen density')
      if (surface.dataset.samplingMode === 'native') {
        assert(Math.abs(Number(canvas.dataset.tileZoom) - view.zoom * devicePixelRatio) < 1e-9, 'Native chrome must keep exact device sampling')
        assert(Math.abs(density - devicePixelRatio) < 1e-6, `Native sampling must remain unscaled: ${JSON.stringify({density,dpr:devicePixelRatio,tile:canvas.dataset,style:canvas.style.width})}`)
      }
    }
    const metrics = { ...surface.dataset }
    report.stages.push({ name: `surface ${view.zoom}`, nodes: Object.keys(doc.nodes).length,
      ms: Math.round(performance.now() - start), tiles: compositor ? Number(compositor.dataset.compositorTiles) : exact.length, dpr: devicePixelRatio, width, height, metrics }); publish()
    return metrics
  }
  for (const view of [
    { x: 0.25, y: 0.75, zoom: 0.472 },
    { x: -71.125, y: 32.375, zoom: 0.7639 },
    { x: 0.125, y: 0.375, zoom: 2 },
    { x: width / 2 - center.x * 7.639 + 0.125, y: height / 2 - center.y * 7.639 + 0.375, zoom: 7.639 },
  ]) await present(view)
  const at = (zoom: number) => ({ x:width/2-center.x*zoom, y:height/2-center.y*zoom, zoom })
  const base = await present(at(2.72))
  for (const zoom of [2.74, 2.78]) {
    const changed = await present(at(zoom))
    assert(Math.abs(Number(changed.samplingScale) - zoom * devicePixelRatio) < 1e-8, 'Adaptive density must follow the settled camera')
  }
  const beforeRevisit = host.querySelector<HTMLElement>('.kernel-tiles')!.dataset.viewportTilesRendered
  const cached = await present(at(2.72))
  assert(cached.samplingScale === base.samplingScale && cached.viewportTilesRendered === beforeRevisit,
    'A covered density revisit must reuse its resident pixels')
  const higher = await present(at(3.3))
  assert(Number(higher.samplingScale) > Number(base.samplingScale), 'Crossing the level must upgrade detail')
  await present(at(2.72), true)
  width = 2560; height = 1440
  Object.assign(host.style, {width:`${width}px`,height:`${height}px`})
  await present(at(1))
  root.unmount()
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.errors.push(String(error)) }
publish()
