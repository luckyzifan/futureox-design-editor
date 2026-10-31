import { afterEach, expect, test, vi } from 'vitest'
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasScrollbars } from './CanvasScrollbars'
import { Editor } from './engine'
import { blank } from './model'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const dom = new JSDOM('<div id="root"></div>')
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const editor = new Editor(blank()), callback = vi.fn(), root = createRoot(document.getElementById('root')!)
  const render = () => act(() => root.render(<CanvasScrollbars editor={editor} entries={[]} view={editor.state.view} size={{ width: 800, height: 600 }} onPanGestureChange={callback} />))
  render()
  const bar = document.querySelector('.horizontal') as HTMLElement
  const thumb = bar.querySelector('.canvas-scrollbar-thumb') as HTMLElement
  let captured = false
  bar.setPointerCapture = () => { captured = true }; bar.hasPointerCapture = () => captured; bar.releasePointerCapture = () => { captured = false }
  function event(type: string, x: number, pointerId = 7, target: HTMLElement = bar) {
    const ev = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x })
    Object.defineProperty(ev, 'pointerId', { value: pointerId })
    act(() => target.dispatchEvent(ev))
  }
  cleanup = () => { act(() => root.unmount()); editor.dispose(); dom.window.close() }
  return { editor, callback, render, bar, thumb, event }
}
test('thumb range stays fixed while dragging and renderer receives held/released lifecycle', () => {
  const f = fixture(), width = f.thumb.style.width, left = parseFloat(f.thumb.style.left)
  f.event('pointerdown', 100, 7, f.thumb)
  expect(f.callback.mock.calls).toEqual([[true]])
  f.event('pointermove', 140); f.editor.flushPendingView(); f.render()
  expect(f.thumb.style.width).toBe(width)
  expect(parseFloat(f.thumb.style.left)).toBeCloseTo(left + 40)
  f.event('pointerup', 140, 99)
  expect(f.callback.mock.calls).toEqual([[true]])
  f.event('pointerup', 150)
  expect(f.callback.mock.calls).toEqual([[true], [false]])
  expect(f.editor.state.view.x).not.toBe(0)
})
test.each(['pointercancel', 'lostpointercapture'])('%s ends only the matching gesture', kind => {
  const f = fixture(); f.event('pointerdown', 100, 7, f.thumb)
  f.event(kind, 100, 99); expect(f.callback.mock.calls).toEqual([[true]])
  f.event(kind, 100); expect(f.callback.mock.calls).toEqual([[true], [false]])
})
test('page replacement clears a held scrollbar before the new canvas gesture', () => {
  const f = fixture(); f.event('pointerdown', 100, 7, f.thumb)
  f.editor.state.page = 'another-page'; f.render()
  expect(f.callback.mock.calls).toEqual([[true], [false]])
})
