import { ResidentPresenter, type ResidentFrame } from '../../frontend/design-client/src/kernel/gpu/resident-presenter'
import { TileCompositor, type CompositeItem } from '../../frontend/design-client/src/kernel/gpu/tile-compositor'
const expected = new URL(location.href).searchParams.get('expected') || 'candidate'
const report: any = { status: 'running', expected, scope: 'actual GPU presentation pixels, per-backend oracle; no physical scanout or timing claim', cases: [] }
const publish = () => { (window as any).__presentationReport = report; document.querySelector('#results')!.textContent = JSON.stringify({ status: report.status, error: report.error }) }
const color = (width: number, height: number, rgba: number[]) => {
  const bytes = new Uint8Array(width * height * 4)
  for (let i = 0; i < bytes.length; i += 4) bytes.set(rgba, i)
  return bytes
}
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])
const describe = (pixels: Uint8ClampedArray | Uint8Array, width: number, height: number) => ({
  width, height, pixels: Array.from(pixels), zeroAlpha: pixels.filter((v, i) => i % 4 === 3 && v === 0).length,
})
try {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw Error('No WebGPU adapter')
  report.adapter = { ...adapter.info, fallback: adapter.info.isFallbackAdapter }
  const device = await adapter.requestDevice(), format = navigator.gpu.getPreferredCanvasFormat()
  const canvas = new OffscreenCanvas(16, 16), events: any[] = []
  const presenter = new ResidentPresenter(device, canvas, format, row => events.push(row))
  const capture = (w: number, h: number, rgba: number[]) => {
    const result = presenter.capture(w, h), data = color(w, h, rgba)
    if (format.startsWith('bgra')) for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]]
    device.queue.writeTexture({ texture: result.texture }, data, { bytesPerRow: w * 4 }, [w, h])
    return result.id
  }
  const item = (id: number, w: number, h: number, x = 0, layer = 0) => ({ active: true, layer, gutter: 0,
    tile: { gpuTile: id, serial: id, key: String(id), x, y: 0, width: w, height: h, zoom: 1 } })
  const full = capture(16, 16, [30, 90, 150, 255]), half = capture(8, 16, [200, 40, 10, 255]), wide = capture(32, 16, [60, 180, 30, 255])
  const frame = (items: any[], width = 16): ResidentFrame => ({ view: { x: 0, y: 0, zoom: 1 }, width, height: 16, dpr: 1, items })
  const read = async () => {
    const { bitmap, contentFrame } = await presenter.captureContentBitmap()
    try { const c = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d')!; ctx.drawImage(bitmap, 0, 0)
      return { ...describe(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height), contentFrame }
    } finally { bitmap.close() }
  }
  presenter.draw(frame([item(full, 16, 16)])); const before = await read()
  presenter.draw(frame([item(half, 8, 16)])); const partial = await read()
  presenter.draw(frame([item(full, 16, 16), item(half, 8, 16, 0, 2)])); const covered = await read()
  presenter.draw(frame([item(full, 16, 16)], 32)); const resizedPartial = await read()
  presenter.draw(frame([item(wide, 32, 16)], 32)); const resizedComplete = await read()
  // Complete authored transparency must still replace old opaque pixels.
  const transparent = capture(16, 16, [0, 0, 0, 0])
  presenter.draw(frame([item(transparent, 16, 16)])); const authoredTransparent = await read()
  report.cases.push({ backend: 'webgpu', before, partial, covered, resizedPartial, resizedComplete, authoredTransparent,
    deferred: events.filter(e => e.coverageDeferred).length, submits: events.filter(e => e.presented).length })
  presenter.dispose(); await device.queue.onSubmittedWorkDone(); device.destroy()

  const glCanvas = document.createElement('canvas'); document.body.append(glCanvas)
  const compositor = new TileCompositor(glCanvas)
  let serial = 0
  const tile = (w: number, h: number, rgba: number[]): CompositeItem => ({ active: true, layer: 0, gutter: 0,
    tile: { key: String(++serial), serial, x: 0, y: 0, width: w, height: h, zoom: 1, bytes: color(w, h, rgba) } })
  const a = tile(16, 16, [30, 90, 150, 255]), b = tile(8, 16, [200, 40, 10, 255]), c = tile(32, 16, [60, 180, 30, 255]), t = tile(16, 16, [0, 0, 0, 0])
  for (const i of [a, b, c, t]) compositor.upload(i.tile)
  const readGl = () => { const c = new OffscreenCanvas(glCanvas.width, glCanvas.height), ctx = c.getContext('2d')!; ctx.drawImage(glCanvas, 0, 0)
    return describe(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height) }
  const draw = (items: CompositeItem[], width = 16) => compositor.draw(items, { x: 0, y: 0, zoom: 1 }, width, 16, 1)
  draw([a]); const ga = readGl(); draw([b]); const gb = readGl(); draw([a, { ...b, layer: 2 }]); const gc = readGl()
  draw([a], 32); const gd = readGl(); draw([c], 32); const ge = readGl(); draw([t]); const gf = readGl()
  report.cases.push({ backend: 'webgl2', before: ga, partial: gb, covered: gc, resizedPartial: gd, resizedComplete: ge, authoredTransparent: gf })
  compositor.dispose(); glCanvas.remove()
  for (const c of report.cases) {
    if (c.before.zeroAlpha || c.covered.zeroAlpha || c.resizedComplete.zeroAlpha || c.authoredTransparent.zeroAlpha !== 256)
      throw Error(c.backend + ': full coverage or authored Alpha changed')
    if (expected === 'baseline') {
      if (c.partial.zeroAlpha !== 128 || c.resizedPartial.zeroAlpha !== 256) throw Error(c.backend + ': old transparent-clear failure was not reproduced')
    } else {
      if (!same(c.before.pixels, c.partial.pixels) || !same(c.covered.pixels, c.resizedPartial.pixels) || c.resizedPartial.width !== 16)
        throw Error(c.backend + ': incomplete frame replaced or resized the complete frame')
    }
  }
  report.status = expected === 'baseline' ? 'baseline-reproduced' : 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error) }
publish()
