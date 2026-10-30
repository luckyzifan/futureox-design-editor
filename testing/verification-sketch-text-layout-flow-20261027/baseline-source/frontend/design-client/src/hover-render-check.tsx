import { Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { initializePicking } from './kernel/picking'
import './styles.css'

const output = document.querySelector('#results')!
const frame = () => new Promise(requestAnimationFrame)
try {
  await initializePicking()
  const doc = blank('hover regression'), shape = node('rectangle', 40, 40, 500, 400)
  shape.fills = [paint('#4477dd')]; doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  const editor = new Editor(doc)
  let commits = 0
  createRoot(document.querySelector('#root')!).render(<Profiler id="canvas" onRender={() => { commits++ }}><Canvas editor={editor}/></Profiler>)
  const start = performance.now()
  while (document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady !== 'true') {
    if (performance.now() - start > 60000) throw Error('Canvas initialization timed out')
    await frame()
  }
  // Allow the already scheduled offscreen fill and React acknowledgements to
  // finish before measuring a steady unchanged hover target.
  for (let i = 0; i < 60; i++) await frame()
  const host = document.querySelector<HTMLElement>('#design-canvas-view')!
  const point = (dx: number) => {
    const bounds = host.getBoundingClientRect(), view = editor.state.view
    return { clientX: bounds.left + view.x + (240 + dx) * view.zoom, clientY: bounds.top + view.y + 200 * view.zoom }
  }
  const move = (dx: number) => host.dispatchEvent(new PointerEvent('pointermove', {
    ...point(dx), bubbles: true, pointerId: 9, pointerType: 'mouse', isPrimary: true,
  }))
  move(0); for (let i = 0; i < 6; i++) await frame()
  if (editor.state.hover !== shape.id) throw Error('Hover target did not resolve')
  const before = commits, started = performance.now()
  for (let i = 0; i < 120; i++) { move(i % 20); move(i % 20 + .2); move(i % 20 + .4); await frame() }
  for (let i = 0; i < 3; i++) await frame()
  const hoverCommits = commits - before
  if (editor.state.hover !== shape.id || !editor.pointerLocation) throw Error('Hover state became stale')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true }))
  await frame(); move(10); await frame()
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft', bubbles: true }))
  host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerId: 9, pointerType: 'mouse', relatedTarget: document.body }))
  for (let i = 0; i < 3; i++) await frame()
  const report = { status: 'passed', rawMoves: 360, frames: 120, hoverCommits,
    durationMs: performance.now() - started, leftTarget: editor.state.hover === null }
  if (!report.leftTarget) throw Error('Pointer leave did not clear hover')
  output.textContent = JSON.stringify(report)
} catch (error) { output.textContent = JSON.stringify({ status: 'failed', error: String(error) }) }
