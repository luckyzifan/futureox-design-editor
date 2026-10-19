import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { KernelSurface } from './Surface'
import { initializePicking } from './picking'
import { renderRuntimeEvidence } from './runtime-evidence'
import { scene, unionBounds } from '../geometry'
import type { DesignDocument } from '../model'
import { captureContentPlane } from './content-plane'
const host = document.querySelector<HTMLElement>('#canvas')!, output = document.querySelector('#results')!
const continuity = new URLSearchParams(location.search).has('continuity')
const coldWide = new URLSearchParams(location.search).has('coldwide')
const report: { status: string; stages: unknown[]; error?: string; runtime?: unknown } = { status: 'running', stages: [] }
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const frame = () => new Promise<number>(requestAnimationFrame)
try {
  report.runtime = await renderRuntimeEvidence()
  await initializePicking()
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document required')
  const input = await response.json(), doc: DesignDocument = input.document || input
  const page = doc.pages[0], selected = doc.nodes[page.children[Number(new URLSearchParams(location.search).get("root")) || 0]], width = 1000, height = 640
  const entries = scene(doc, page.id)
  const overview = unionBounds(entries.filter(e => e.depth === 0).map(e => e.bounds))
  const center = { x: selected.transform[4] + selected.width / 2, y: selected.transform[5] + selected.height / 2 }
  const root = createRoot(host)
  const render = (zoom: number, panX = 0) => flushSync(() => root.render(<KernelSurface document={doc} pageId={page.id}
    width={width} height={height} grid={false} overview={overview} presentationEpoch={1}
    view={{ x: width / 2 - center.x * zoom + panX, y: height / 2 - center.y * zoom, zoom }} />))
  const state = () => {
    const tiles = host.querySelector<HTMLElement>('.kernel-tiles')?.dataset
    const display = host.querySelector<HTMLCanvasElement>('.kernel-compositor')?.dataset
    const camera = JSON.parse(display?.presentedCamera || '{}')
    const regions = JSON.parse(display?.worldCoverage || '[]') as { x: number; y: number; width: number; height: number; density: number }[]
    let required = 0, covered = 0, sharpContent = 0
    // Only pixels where this document has content can be missing content.
    // Outside these root bounds the existing page background is the correct
    // image; no fictitious raster coverage is counted there.
    for (const entry of entries.filter(e => e.depth === 0)) {
      const b = entry.bounds, left = Math.max(b.x, -camera.x / camera.zoom), top = Math.max(b.y, -camera.y / camera.zoom)
      const right = Math.min(b.x + b.width, (width - camera.x) / camera.zoom), bottom = Math.min(b.y + b.height, (height - camera.y) / camera.zoom)
      if (!(right > left && bottom > top)) continue
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
        const px = left + (right - left) * (x + .5) / 5, py = top + (bottom - top) * (y + .5) / 5
        const hits = regions.filter(r => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height)
        required++; if (hits.length) covered++
        if (hits.some(r => r.density >= camera.zoom * devicePixelRatio * .999)) sharpContent++
      }
    }
    return { ready: tiles?.detailReady === 'true', zoom: Number(tiles?.requestedCameraZoom),
      presentedZoom: JSON.parse(display?.presentedCamera || '{}').zoom as number | undefined,
      contentCoverage: required ? covered / required : 1, sharpContent: required ? sharpContent / required : 1,
      coverage: Number(display?.coverage || 0), sharp: Number(display?.sharpCoverage || 0),
      nativeComplete: display?.nativeCoverageComplete===undefined ? tiles?.detailReady==='true' : display.nativeCoverageComplete==='true',
      nativeCaptureTiles:Number(tiles?.nativeCaptureTiles||0),
      upscale: Number(display?.maxUpscale || 0), rendered: Number(tiles?.tilesRendered || 0),
      previews: Number(tiles?.viewportPreviewTiles || 0), error: host.querySelector('.kernel-status.error')?.textContent }
  }
  const settle = async () => {
    const started = performance.now()
    while (!state().ready || state().presentedZoom !== state().zoom || !state().nativeComplete || state().coverage < .999) {
      if (state().error) throw Error(state().error!)
      if (performance.now() - started > 120000) throw Error('Exact refinement timed out')
      await frame()
    }
    await frame()
    return performance.now() - started
  }
  const start = performance.now()
  let firstPixelsMs: number | undefined, firstSharpPixelsMs: number | undefined, fullCoverageMs: number | undefined, nativeViewportMs: number | undefined
  let observing = true
  const readPixels=async()=>{
    const content=await captureContentPlane(host.querySelector<HTMLCanvasElement>('.kernel-compositor')!)
    const canvas=document.createElement('canvas');canvas.width=content.bitmap.width;canvas.height=content.bitmap.height
    const context=canvas.getContext('2d',{willReadFrequently:true})!;context.drawImage(content.bitmap,0,0);content.bitmap.close()
    return context.getImageData(0,0,canvas.width,canvas.height).data
  }
  let initialPixels: Promise<Uint8ClampedArray> | undefined
  const observe = () => {
    const shown = state(), ms = performance.now() - start
    if (shown.coverage > 0) firstPixelsMs ??= ms
    if (shown.sharp > 0) firstSharpPixelsMs ??= ms
    if (shown.coverage >= .999) fullCoverageMs ??= ms
    if(shown.nativeComplete&&shown.presentedZoom===shown.zoom){
      nativeViewportMs??=ms
      if(shown.nativeCaptureTiles>0&&!initialPixels&&new URLSearchParams(location.search).has('initialOracle'))initialPixels=readPixels()
    }
    if (observing) requestAnimationFrame(observe)
  }
  render(coldWide ? .8 : continuity ? .025 : .2); requestAnimationFrame(observe); await settle(); observing = false
  report.stages.push({ name: 'initial', ms: performance.now() - start, firstPixelsMs, firstSharpPixelsMs,
    fullCoverageMs, nativeViewportMs, ...state(), nodes: Object.keys(doc.nodes).length }); publish()
  if(new URLSearchParams(location.search).has('initialOracle')&&!initialPixels)throw Error('Native viewport capture was not exercised')
  if(initialPixels){
    const first=await initialPixels,finished=await readPixels();let max=0,changed=0
    if(first.length!==finished.length)throw Error('Initial viewport oracle dimensions changed')
    for(let i=0;i<first.length;i++){const d=Math.abs(first[i]-finished[i]);max=Math.max(max,d);if(d)changed++}
    report.stages.push({name:'initial native viewport vs completed tiles',max,changed});publish()
    if(max)throw Error('Initial native viewport changed sampled pixels')
  }
  const idle = Math.max(0, Math.min(5000, Number(new URLSearchParams(location.search).get('idle')) || 0))
  if (idle) {
    const at = performance.now()
    while (performance.now() - at < idle) await frame()
    report.stages.push({ name: 'idle page coverage', ms: performance.now() - at,
      overviewReuses: Number(host.querySelector<HTMLElement>('.kernel-tiles')?.dataset.overviewReuses || 0),
      rasterTrace: JSON.parse(host.querySelector<HTMLElement>('.kernel-tiles')?.dataset.rasterTrace || '[]') }); publish()
  }
  const gesture = async (name: string, zooms: number[]) => {
    const samples: ReturnType<typeof state>[] = [], started = performance.now(), before = state().rendered
    for (const zoom of zooms) { render(zoom); await frame(); samples.push(state()) }
    const settleMs = await settle()
    report.stages.push({ name, gestureMs: performance.now() - started - settleMs, settleMs,
      newTiles: state().rendered - before, samples, final: state(),
      rasterTrace: JSON.parse(host.querySelector<HTMLElement>('.kernel-tiles')?.dataset.rasterTrace || '[]') }); publish()
    if (samples.some(sample => sample.contentCoverage < .999 || sample.error) || state().sharp < .999)
      throw Error(`Incomplete presentation: ${name}`)
  }
  const ramp = (from: number, to: number) => Array.from({ length: 24 }, (_, i) => from * (to / from) ** ((i + 1) / 24))
  // This deliberately starts without any wide cached frame. It is a stricter
  // cold coverage boundary than revisiting an already rendered whole page.
  if (coldWide) await gesture('cold wide zoom out .8 to .025', ramp(.8, .025))
  await gesture('cold zoom to .8', ramp(continuity || coldWide ? .025 : .2, .8))
  if (continuity) {
    await gesture('wide return .8 to .025', ramp(.8, .025))
    await gesture('return to .8', ramp(.025, .8))
  }
  await gesture('rapid .8 to .15 to .8', [...ramp(.8, .15), ...ramp(.15, .8)])
  await gesture('rapid revisit .8 to .3 to .8', [...ramp(.8, .3), ...ramp(.3, .8)])
  await gesture('rapid direction reversals', Array.from({ length: 3 }, () =>
    [.25, 1.2, .4, .8].flatMap(zoom => [zoom, zoom, zoom])).flat())
  if (continuity) await gesture('repeat scale churn', Array.from({ length: 12 }, () =>
    [...ramp(.8, 4), ...ramp(4, .025), ...ramp(.025, .8)]).flat())
  await gesture('1000 percent zoom and return', [...ramp(.8, 10), ...ramp(10, .8)])
  if (new URLSearchParams(location.search).has('stress')) {
    // Inspect real glyphs at high zoom, rather than only the board's white
    // interior (which can have complete texture coverage but proves little).
    const text = entries.filter(entry => entry.ancestors.includes(selected.id) && doc.nodes[entry.id].kind === 'text')
      .sort((a, b) => doc.nodes[b.id].fontSize - doc.nodes[a.id].fontSize)[0]
    if (!text) throw Error('A visible text node is required for high-zoom verification')
    center.x = text.bounds.x + text.bounds.width / 2; center.y = text.bounds.y + text.bounds.height / 2
    report.stages.push({ name: 'high zoom text focus', id: text.id, bounds: text.bounds })
    await gesture('1000 percent native refinement', ramp(.8, 10))
    const samples: ReturnType<typeof state>[] = [], started = performance.now(), before = state().rendered
    for (let i = 1; i <= 24; i++) { render(10, i * 50); await frame(); samples.push(state()) }
    const settleMs = await settle()
    report.stages.push({ name: '1000 percent pan 1200 CSS pixels', gestureMs: performance.now() - started - settleMs,
      settleMs, newTiles: state().rendered - before, samples, final: state(),
      lodScale: Number(host.querySelector<HTMLElement>('.kernel-tiles')!.dataset.lodScale) }); publish()
    if (samples.some(sample => sample.coverage < .999 || sample.error)) throw Error('Incomplete high-zoom pan')
  }
  report.stages.push({ name: 'raster trace', trace: JSON.parse(host.querySelector<HTMLElement>('.kernel-tiles')!.dataset.rasterTrace || '[]') })
  report.status = 'passed'; publish()
} catch (error) { report.status = 'failed'; report.error = String(error); publish() }
