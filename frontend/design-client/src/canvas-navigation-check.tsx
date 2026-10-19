import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Editor } from './engine'
import { scene, apply } from './geometry'
import { initializePicking } from './kernel/picking'
import type { DesignDocument } from './model'
import './styles.css'

const output = document.querySelector('#results')!
const report: { status: string; stages: any[]; error?: string } = { status: 'running', stages: [] }
const publish = async () => { output.textContent = JSON.stringify(report, null, 2); await fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) }) }
const frame = () => new Promise<number>(requestAnimationFrame)
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] || 0
try {
  await initializePicking()
  const input = await (await fetch(new URLSearchParams(location.search).has('117') ? '/__render_fixture_117' : '/__render_fixture')).json()
  const doc: DesignDocument = input.document || input, page = doc.pages[0]
  const target = scene(doc, page.id).filter(e => doc.nodes[e.id].kind === 'text')
    .sort((a, b) => doc.nodes[b.id].fontSize - doc.nodes[a.id].fontSize)[0]
  const n = doc.nodes[target.id], point = apply(target.matrix, { x: n.width / 2, y: n.height / 2 })
  const editor = new Editor(doc), startView = { x: 500 - point.x, y: 360 - point.y, zoom: 1 }
  editor.set({ view: startView })
  if (new URLSearchParams(location.search).has('selection-profile')) {
    const at = performance.now()
    for (let i = 0; i < 100; i++) editor.topSelection()
    report.stages.push({ name: '100 empty topSelection calls', ms: performance.now() - at, nodes: Object.keys(doc.nodes).length })
    report.status = 'complete'; await publish()
  } else {
  let canvasCommits = 0, panelCommits = 0, hitCalls = 0, hitMs = 0
  const renderMs: number[] = [], hit = editor.hit.bind(editor)
  editor.hit = (...args) => { const at = performance.now(); hitCalls++; try { return hit(...args) } finally { hitMs += performance.now() - at } }
  createRoot(document.querySelector('#root')!).render(<>
    <Profiler id="layers" onRender={() => { panelCommits++ }}><Layers editor={editor} section="layers" onSection={() => {}} /></Profiler>
    <Profiler id="canvas" onRender={(_id, _phase, ms) => { canvasCommits++; renderMs.push(ms) }}><Canvas editor={editor} /></Profiler>
  </>)
  const host = () => document.querySelector<HTMLElement>('#design-canvas-view')!
  const waitReady = async () => { const start = performance.now(); while (document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady !== 'true') {
    if (performance.now() - start > 120000) throw Error('Real document did not settle'); await frame()
  } }
  await waitReady()
  const pointAt = () => { const box = host().getBoundingClientRect(), v = editor.state.view; return { clientX: box.left + v.x + point.x * v.zoom, clientY: box.top + v.y + point.y * v.zoom } }
  const pointer = (p = pointAt()) => host().dispatchEvent(new PointerEvent('pointermove', { ...p, bubbles: true, pointerId: 2, pointerType: 'mouse', isPrimary: true }))
  const outline = () => { const el = host().querySelector<SVGElement>('[data-testid="canvas-hover-outline"]'); return el && getComputedStyle(el).visibility !== 'hidden' ? el : null }
  const hoverAt = performance.now(), hoverHitAt = hitMs
  const samples: { id: string | null; width: number; height: number }[] = []
  for (let i = 0; i < 30; i++) {
    const p = pointAt(); pointer({ clientX: p.clientX + (i % 5 - 2) * .2, clientY: p.clientY + (i % 3 - 1) * .2 })
    await frame(); const el = outline(), box = el?.getBoundingClientRect()
    samples.push({ id: el?.getAttribute('data-node-id') || null, width: box?.width || 0, height: box?.height || 0 })
  }
  report.stages.push({ name: 'stationary text jitter', nodes: Object.keys(doc.nodes).length, target: target.id, samples,
    elapsedMs: performance.now() - hoverAt, hitMs: hitMs - hoverHitAt }); await publish()
  if (samples.some(sample => sample.id !== target.id || sample.width !== samples[0].width || sample.height !== samples[0].height))
    throw Error('Stationary text hover changed target or bounds')
  for (const zoom of [false, true]) {
    editor.set({ view: startView }); await waitReady(); pointer(); for (let i = 0; i < 8; i++) await frame()
    const p = pointAt(), base = { canvasCommits, panelCommits, hitCalls, hitMs }, rendersAt = renderMs.length
    const intervals: number[] = [], lag: number[] = [], centerError: number[] = [], zoomError: number[] = [], targets = new Set<string>()
    let previous = await frame(), visibleOutlines = 0
    for (let i = 0; i < 120; i++) {
      for (let j = 0; j < 3; j++) host().dispatchEvent(new WheelEvent('wheel', {
        ...p, bubbles: true, cancelable: true, deltaX: zoom ? 0 : 3, deltaY: zoom ? (i < 60 ? -1 : 1) : 0, ctrlKey: zoom,
      }))
      const now = await frame(); intervals.push(now - previous); previous = now
      const el = outline(); if (el) { visibleOutlines++; targets.add(el.getAttribute('data-node-id')!) }
      const shown = JSON.parse(host().querySelector<HTMLElement>('.kernel-compositor')?.dataset.presentedCamera || '{}')
      if (Number.isFinite(shown.x)) {
        const v = editor.state.view, w = host().clientWidth, h = host().clientHeight
        lag.push(Math.abs(shown.x - v.x))
        centerError.push(Math.hypot((w / 2 - v.x) / v.zoom * shown.zoom + shown.x - w / 2,
          (h / 2 - v.y) / v.zoom * shown.zoom + shown.y - h / 2))
        zoomError.push(Math.abs(Math.log2(shown.zoom / v.zoom)))
      }
    }
    report.stages.push({ name: zoom ? 'pinch zoom' : 'wheel pan', canvasCommits: canvasCommits - base.canvasCommits,
      panelCommits: panelCommits - base.panelCommits, hitCalls: hitCalls - base.hitCalls, hitMs: hitMs - base.hitMs,
      visibleOutlines, hoverTargets: [...targets], frameP50: percentile(intervals, .5), frameP95: percentile(intervals, .95),
      renderP95: percentile(renderMs.slice(rendersAt), .95), cameraLagP95: percentile(lag, .95),
      presentedCenterErrorP95: percentile(centerError, .95), presentedZoomOctaveErrorP95: percentile(zoomError, .95) }); await publish()
    if (visibleOutlines || hitCalls !== base.hitCalls) throw Error('Navigation churned canvas hover')
    await waitReady(); for (let i = 0; i < 20; i++) await frame()
  }
  editor.set({ view: startView }); await waitReady(); pointer()
  for (let i = 0; i < 30; i++) await frame()
  const restored = outline()?.getAttribute('data-node-id')
  report.stages.push({ name: 'hover resumes after navigation', target: target.id, actual: restored })
  if (restored !== target.id) throw Error('Hover did not resume after navigation')
  const controls = host().querySelector<HTMLElement>('.canvas-controls')!
  controls.dispatchEvent(new PointerEvent('pointermove', { ...pointAt(), bubbles: true, pointerId: 2, pointerType: 'mouse' }))
  for (let i = 0; i < 4; i++) await frame()
  if (outline()) throw Error('Canvas controls leaked hover to the document')
  report.stages.push({ name: 'controls do not pick underlying content', passed: true })
  const minimap = host().querySelector<HTMLElement>('.canvas-minimap')
  if (minimap) {
    pointer(); for (let i = 0; i < 4; i++) await frame()
    if (!outline()) throw Error('Missing hover before minimap boundary')
    minimap.dispatchEvent(new PointerEvent('pointermove', { ...pointAt(), bubbles: true, pointerId: 2, pointerType: 'mouse' }))
    for (let i = 0; i < 4; i++) await frame()
    if (outline()) throw Error('Minimap retained a stale canvas hover')
    report.stages.push({ name: 'minimap cancels queued canvas hover', passed: true })
  }
  report.status = 'complete'; await publish()
  }
} catch (error) { report.status = 'failed'; report.error = String(error); await publish() }
