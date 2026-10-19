import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { KernelSurface } from './Surface'
import { initializePicking } from './picking'
import { scene, unionBounds } from '../geometry'
import type { DesignDocument } from '../model'

const host = document.querySelector('#canvas')!, output = document.querySelector('#results')!
const pan = new URLSearchParams(location.search).has('pan')
const report: { status: string; stages: unknown[]; error?: string } = { status: 'running', stages: [] }
const publish = async () => {
  output.textContent = JSON.stringify(report, null, 2)
  await fetch(pan ? '/__render_report_pan' : '/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const frame = () => new Promise(requestAnimationFrame)
try {
  await initializePicking()
  const input = await (await fetch('/__render_fixture')).json(), doc: DesignDocument = input.document || input
  const page = doc.pages[0], node = doc.nodes[page.children[0]], width = 1000, height = 640
  const entries = scene(doc, page.id), overview = unionBounds(entries.filter(e => e.depth === 0).map(e => e.bounds))
  const text = entries.filter(e => e.ancestors.includes(node.id) && doc.nodes[e.id].kind === 'text')
    .sort((a, b) => doc.nodes[b.id].fontSize - doc.nodes[a.id].fontSize)[0]
  const center = { x: text.bounds.x + text.bounds.width / 2, y: text.bounds.y + text.bounds.height / 2 }
  const root = createRoot(host)
  const render = (zoom: number, x = 0) => flushSync(() => root.render(<KernelSurface document={doc} pageId={page.id}
    width={width} height={height} view={{ x: width / 2 - center.x * zoom + x, y: height / 2 - center.y * zoom, zoom }}
    grid={false} overview={overview} presentationEpoch={1} />))
  const state = () => {
    const t = host.querySelector<HTMLElement>('.kernel-tiles')?.dataset, d = host.querySelector<HTMLElement>('.kernel-compositor')?.dataset
    return { ready: t?.detailReady === 'true', zoom: Number(t?.requestedCameraZoom),
      presentedZoom: JSON.parse(d?.presentedCamera || '{}').zoom as number | undefined,
      rendered: Number(t?.tilesRendered || 0), frames: Number(d?.compositorFrames || 0),
      sharp: Number(d?.sharpCoverage || 0), coverage: Number(d?.coverage || 0), upscale: Number(d?.maxUpscale || 1),
      error: host.querySelector('.kernel-status.error')?.textContent }
  }
  const settle = async () => {
    const start = performance.now()
    while (!state().ready || state().presentedZoom !== state().zoom || state().sharp < .999) {
      if (state().error || performance.now() - start > 120000) throw Error(state().error || 'Refinement timeout')
      await frame()
    }
    return performance.now() - start
  }
  const initial = pan ? 1 : .25
  render(initial); await settle(); report.stages.push({ name: 'ready', ...state(), nodes: Object.keys(doc.nodes).length }); await publish()
  const start = performance.now(), before = state(), samples: (ReturnType<typeof state> & { at: number })[] = []
  let firstRasterMs: number | undefined
  // Two seconds of uninterrupted input. No pause is inserted for refinement.
  while (performance.now() - start < 2000) {
    const t = Math.min(1, (performance.now() - start) / 2000)
    render(pan ? initial : initial * 4 ** t, pan ? 1200 * t : 0)
    await frame()
    const s = state(), at = performance.now() - start
    if (s.rendered > before.rendered) firstRasterMs ??= at
    samples.push({ at, ...s })
  }
  const end = state()
  report.stages.push({ name: pan ? 'active pan' : 'active zoom', duration: performance.now() - start,
    firstRasterMs, newTilesDuringInput: end.rendered - before.rendered, presentedFramesDuringInput: end.frames - before.frames,
    meanSharpCoverage: samples.reduce((n, s) => n + s.sharp, 0) / samples.length,
    minimumCoverage: Math.min(...samples.map(s => s.coverage)), samples }); await publish()
  render(pan ? initial : 1, pan ? 1200 : 0)
  const settleMs = await settle(); report.stages.push({ name: 'released', settleMs, ...state() })
  if (!firstRasterMs || firstRasterMs >= 1800 || end.rendered <= before.rendered) throw Error('No useful raster progress before input ended')
  report.status = 'passed'; await publish()
} catch (error) { report.status = 'failed'; report.error = String(error); await publish() }
