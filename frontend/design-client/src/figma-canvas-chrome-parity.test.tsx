// Mounted canvas chrome: selection box, hover hairline, marquee, and Alt spacing.
// Also rechecks the #42 group click, empty arrows, and Space-pan. Not a GPU pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { Editor } from './engine'
import { commonValue, selectionMetric } from './selection-properties'
import { blank, node, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { interfacePreference } from './interface-preference'
import { crispOutlinePath } from './kernel/gpu/canvas-overlay'
import { HOVER_BLUE, HOVER_STROKE_PX, MARQUEE_FILL, SELECTION_BLUE, SELECTION_UNION_STROKE_PX } from './selection-blue'
import { SPACING_RED } from './canvas-measurements'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

let dom: any, root: Root, mount: HTMLDivElement, editor: Editor
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  localStorage.clear(); shortcutPreference.set('figma-like'); interfacePreference.set({ locale: 'zh-CN' })
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); interfacePreference.set({ locale: 'zh-CN' }); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
const view = { x: 0, y: 0, zoom: 1 }
function bandSpan(d: string) {
  const quads = [...d.matchAll(/M([-\d.eE]+) ([-\d.eE]+) L([-\d.eE]+) ([-\d.eE]+) L([-\d.eE]+) ([-\d.eE]+) L([-\d.eE]+) ([-\d.eE]+) Z/g)]
  expect(quads.length).toBeGreaterThan(0)
  return quads.map(match => {
    const values = match.slice(1).map(Number)
    const xs = [0, 2, 4, 6].map(index => values[index])
    const ys = [1, 3, 5, 7].map(index => values[index])
    return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  })
}
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id)) {
  const doc = blank('Mac chrome'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  host().dispatchEvent(event)
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  host().dispatchEvent(event)
}
async function flush() {
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(performance.now()) } })
}
async function marquee(from: number[], to: number[], options: MouseEventInit = {}) {
  await act(async () => pointer('pointerdown', from[0], from[1], options))
  await act(async () => pointer('pointermove', to[0], to[1], options))
  await flush()
  await act(async () => pointer('pointerup', to[0], to[1], options))
}

test('a selected layer shows the blue box, white corner handles, and a blue size pill', async () => {
  const rect = node('rectangle', 40, 50, 80, 40)
  await render([rect])
  await act(async () => editor.select([rect.id]))
  const outline = mount.querySelector('[data-testid="canvas-selection-outline"]')
  expect(outline?.getAttribute('stroke')).toBe(SELECTION_BLUE)
  expect(outline?.getAttribute('stroke-width')).toBe('1')
  expect(outline?.getAttribute('data-selection-role')).toBe('object')
  const handles = [...mount.querySelectorAll('[data-testid^="resize-"]')].filter(node => /^resize-\d+$/.test(node.getAttribute('data-testid') || ''))
  expect(handles).toHaveLength(4)
  expect(handles.every(handle => handle.getAttribute('fill') === 'white' && handle.getAttribute('stroke') === SELECTION_BLUE)).toBe(true)
  const pill = mount.querySelector('[data-testid="canvas-selection-size"]')
  expect(pill?.getAttribute('data-pill')).toBe('accent')
  expect(pill?.textContent).toBe('80 × 40')
  expect(pill?.querySelector('text')?.getAttribute('fill')).toBe('#ffffff')
  expect(mount.querySelector('[data-testid="rotate-handle-0"]')).toBeNull()
  expect(mount.querySelector('[data-testid^="corner-radius-"]')).toBeNull()
  expect(mount.querySelector('[data-testid="canvas-selection-outline"]')?.getAttribute('shape-rendering')).toBe('crispEdges')
  expect(mount.querySelector('[data-testid="canvas-hover-outline"]')).toBeNull()
})

test('hover is a lighter hairline and is not drawn on the selected layer', async () => {
  const selected = node('rectangle', 40, 40, 50, 40)
  const other = node('rectangle', 160, 40, 40, 30)
  await render([selected, other])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 180, 55))
  await flush()
  const hover = mount.querySelector('[data-testid="canvas-hover-outline"]')
  expect(hover?.getAttribute('data-node-id')).toBe(other.id)
  expect(hover?.getAttribute('data-chrome')).toBe('hover')
  expect(hover?.getAttribute('fill')).toBe(HOVER_BLUE)
  expect(hover?.getAttribute('stroke')).toBe('none')
  expect(hover?.getAttribute('d')).toBe(crispOutlinePath(
    [{ x: 160, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 70 }, { x: 160, y: 70 }], view, HOVER_STROKE_PX))
  expect(bandSpan(hover?.getAttribute('d') || '').every(span => span === 1)).toBe(true)
  expect(HOVER_BLUE).toBe(SELECTION_BLUE)
  expect(hover?.querySelector('[data-testid^="resize-"]')).toBeNull()
  expect(hover?.querySelector('[data-testid="canvas-selection-size"]')).toBeNull()
  await act(async () => pointer('pointermove', 60, 55))
  await flush()
  expect(mount.querySelector('[data-testid="canvas-hover-outline"]')).toBeNull()
})

test('a drag marquee selects the intersected layer and Shift adds the other', async () => {
  const left = node('rectangle', 40, 40, 50, 40)
  const right = node('rectangle', 200, 40, 60, 40)
  const before = await render([left, right])
  await marquee([180, 20], [280, 100])
  expect(mount.querySelector('[data-testid="canvas-marquee"]')).toBeNull()
  expect(editor.state.selection).toEqual([right.id])
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  await act(async () => editor.select([left.id]))
  await act(async () => pointer('pointerdown', 190, 30, { shiftKey: true }))
  await act(async () => pointer('pointermove', 270, 90, { shiftKey: true }))
  await flush()
  const band = mount.querySelector('[data-testid="canvas-marquee"]')
  expect(band?.getAttribute('fill')).toBe(MARQUEE_FILL)
  expect(band?.getAttribute('stroke')).toBe('none')
  const border = mount.querySelector('[data-testid="canvas-marquee-border"]')
  expect(border?.getAttribute('fill')).toBe(SELECTION_BLUE)
  expect(border?.getAttribute('stroke')).toBe('none')
  expect(border?.getAttribute('d')).toBe(crispOutlinePath(
    [{ x: 190, y: 30 }, { x: 270, y: 30 }, { x: 270, y: 90 }, { x: 190, y: 90 }], view, SELECTION_UNION_STROKE_PX))
  expect(bandSpan(border?.getAttribute('d') || '').every(span => span === 1)).toBe(true)
  await act(async () => pointer('pointerup', 270, 90, { shiftKey: true }))
  expect(editor.state.selection.slice().sort()).toEqual([left.id, right.id].sort())
  // Two pixels touches the right layer's edge. Under the drag threshold this stays a click.
  await marquee([198, 50], [200, 51])
  expect(editor.state.selection).toEqual([])
  expect(editor.state.doc).toBe(before)
})

test('Alt draws red gap lines to the hovered layer, not through the selection', async () => {
  const back = node('rectangle', 0, 0, 400, 300)
  const selected = node('rectangle', 40, 40, 50, 40)
  const sibling = node('rectangle', 140, 40, 40, 40)
  await render([back, selected, sibling])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 60, 55, { altKey: true }))
  await flush()
  expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
  await act(async () => pointer('pointermove', 160, 55, { altKey: true }))
  await flush()
  const lines = [...mount.querySelectorAll('[data-testid="canvas-measurement"]')]
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.every(line => line.querySelector('line')?.getAttribute('stroke') === SPACING_RED)).toBe(true)
  const pills = lines.flatMap(line => [...line.querySelectorAll('[data-pill="measure"]')].map(node => node.textContent))
  expect(pills).toEqual(expect.arrayContaining(['50', '40']))
  await act(async () => key('Alt', { altKey: false }, 'keyup'))
  expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
})

test('Alt inside an empty frame reports the four paddings around the selection', async () => {
  const frame = node('frame', 0, 0, 300, 200)
  const child = node('rectangle', 40, 50, 50, 40)
  frame.children = [child.id]
  await render([frame, child], [frame.id])
  await act(async () => editor.select([child.id]))
  await act(async () => pointer('pointermove', 200, 100, { altKey: true }))
  await flush()
  const distances = [...mount.querySelectorAll('[data-testid="canvas-measurement"] text')].map(node => node.textContent).sort()
  expect(distances).toEqual(['110', '210', '40', '50'])
})

test('an empty canvas has no selection blue, and a hover is an outline only', async () => {
  const target = node('rectangle', 80, 60, 60, 47)
  await render([target])
  await act(async () => pointer('pointermove', 20, 20))
  await flush()
  expect(mount.querySelector('[data-testid="canvas-hover-outline"]')).toBeNull()
  expect(mount.querySelector('[data-testid="canvas-selection-outline"]')).toBeNull()
  expect(mount.querySelector(`[stroke="${SELECTION_BLUE}"]`)).toBeNull()
  await act(async () => pointer('pointermove', 100, 80))
  await flush()
  const hover = mount.querySelector('[data-testid="canvas-hover-outline"]')
  expect(hover?.getAttribute('data-node-id')).toBe(target.id)
  expect(hover?.getAttribute('fill')).toBe(SELECTION_BLUE)
  expect(hover?.getAttribute('stroke')).toBe('none')
  expect(bandSpan(hover?.getAttribute('d') || '').every(span => span === 1)).toBe(true)
  expect(mount.querySelector('[data-testid="canvas-selection-size"]')).toBeNull()
  expect(mount.querySelector('[data-testid="resize-0"]')).toBeNull()
})

test('a 60 by 47 selection shows that size pill, and a three-layer marquee shows Mixed X and Y', async () => {
  interfacePreference.set({ locale: 'en' })
  const a = node('rectangle', 40, 40, 60, 47)
  const b = node('rectangle', 140, 110, 40, 28)
  const c = node('rectangle', 230, 70, 36, 22)
  const doc = blank('Mac chrome')
  doc.nodes = Object.fromEntries([a, b, c].map(item => [item.id, item]))
  doc.pages[0].children = [a.id, b.id, c.id]
  editor.load(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => {
    root.render(<><Canvas editor={editor} /><Inspector editor={editor} /></>)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  host().focus()
  await act(async () => editor.select([a.id]))
  expect(mount.querySelector('[data-testid="canvas-selection-size"]')?.textContent).toBe('60 × 47')
  expect(mount.querySelectorAll('[data-testid^="resize-"]').length).toBeGreaterThanOrEqual(4)
  await act(async () => pointer('pointerdown', 20, 20))
  await act(async () => pointer('pointermove', 280, 160))
  await flush()
  const band = mount.querySelector('[data-testid="canvas-marquee"]')
  expect(band?.getAttribute('fill')).toBe(MARQUEE_FILL)
  expect(band?.getAttribute('stroke')).toBe('none')
  const border = mount.querySelector('[data-testid="canvas-marquee-border"]')
  expect(border?.getAttribute('fill')).toBe(SELECTION_BLUE)
  expect(bandSpan(border?.getAttribute('d') || '').every(span => span === 1)).toBe(true)
  const preview = mount.querySelector('[data-testid="canvas-marquee-selection"]')
  expect(preview?.querySelectorAll('[data-testid="canvas-selection-member"]')).toHaveLength(3)
  expect(preview?.querySelectorAll('[data-testid^="resize-"]')).toHaveLength(4)
  expect(preview?.querySelector('[data-testid="canvas-selection-size"]')?.textContent).toBeTruthy()
  expect(editor.state.selection).toEqual([])
  await act(async () => pointer('pointerup', 280, 160))
  expect(editor.state.selection).toHaveLength(3)
  const nodes = editor.state.selection.map(id => editor.state.doc.nodes[id])
  expect(commonValue(nodes.map(item => selectionMetric(item, 'x', editor.state.doc)))).toBeUndefined()
  expect(commonValue(nodes.map(item => selectionMetric(item, 'y', editor.state.doc)))).toBeUndefined()
  expect(mount.querySelector<HTMLInputElement>('input[aria-label="X"]')?.placeholder).toBe('Mixed')
  expect(mount.querySelector<HTMLInputElement>('input[aria-label="Y"]')?.placeholder).toBe('Mixed')
  expect(editor.canUndo).toBe(false)
})

test('a one-pixel gap shows both widths and a 1 at each end of the seam', async () => {
  const selected = node('rectangle', 40, 40, 20, 20)
  const neighbor = node('rectangle', 61, 40, 20, 20)
  await render([selected, neighbor])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 70, 50, { altKey: true }))
  await flush()
  const guide = mount.querySelector('[data-testid="canvas-measurement"]')
  const pills = [...(guide?.querySelectorAll('[data-pill="measure"]') ?? [])].map(node => node.textContent).sort()
  expect(pills).toEqual(['1', '1', '20', '20'])
  expect(guide?.querySelector('[data-measure="box"]')?.getAttribute('stroke')).toBe(SPACING_RED)
  expect(guide?.querySelector('[data-measure="gap"]')?.getAttribute('stroke')).toBe(SPACING_RED)
  expect(mount.querySelector('[data-testid="canvas-selection-size"]')?.textContent).toBe('20 × 20')
})

test('group click, empty arrows, and Space-pan stay as they were', async () => {
  const group = node('group', 40, 40, 160, 80)
  const child = node('rectangle', 10, 10, 30, 30)
  group.children = [child.id]
  const before = await render([group, child], [group.id])
  await act(async () => pointer('pointerdown', 60, 60))
  await act(async () => pointer('pointerup', 60, 60))
  expect(editor.state.selection).toEqual([group.id])
  expect(editor.state.doc).toBe(before)
  await act(async () => editor.select([]))
  const view = { ...editor.state.view }
  await act(async () => { key('ArrowRight'); key('ArrowDown', { shiftKey: true }) })
  expect(editor.state.view).toEqual(view)
  await act(async () => editor.select([child.id]))
  await act(async () => key(' ', { code: 'Space' }))
  await act(async () => pointer('pointerdown', 60, 60))
  await act(async () => pointer('pointermove', 100, 90))
  await act(async () => pointer('pointerup', 100, 90))
  await act(async () => key(' ', { code: 'Space' }, 'keyup'))
  expect(editor.state.doc.nodes[child.id].transform).toEqual(before.nodes[child.id].transform)
  expect(editor.state.view.x).toBe(view.x + 40)
  expect(editor.state.view.y).toBe(view.y + 30)
  expect(editor.canUndo).toBe(false)
})
