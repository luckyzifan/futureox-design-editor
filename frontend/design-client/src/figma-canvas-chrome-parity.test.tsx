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
import { blank, defaultTextStyle, node, type DesignDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { interfacePreference } from './interface-preference'
import { crispOutlinePath } from './kernel/gpu/canvas-overlay'
import { HOVER_BLUE, HOVER_STROKE_PX, MARQUEE_FILL, SELECTION_BLUE, SELECTION_UNION_STROKE_PX } from './selection-blue'
import { SPACING_RED } from './canvas-measurements'
import { resetFigmaDevMode } from './figma-dev-mode'
import { kernelTextLayout } from './kernel/picking'

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
  dom.window.Element.prototype.setPointerCapture = () => {}
  dom.window.Element.prototype.hasPointerCapture = () => false
  dom.window.Element.prototype.releasePointerCapture = () => {}
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  localStorage.clear(); shortcutPreference.set('figma-like'); interfacePreference.set({ locale: 'zh-CN' })
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  resetFigmaDevMode()
  await act(async () => root.unmount()); editor.dispose(); interfacePreference.set({ locale: 'zh-CN', uiMode: 'figma' }); dom.window.close()
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
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), schemaVersion: DesignDocument['schemaVersion'] = 2) {
  const doc = blank('Mac chrome'); doc.schemaVersion = schemaVersion; doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}, target: Element = host()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event)
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

test('Sketch uses the clicked member of a multi-selection as the alignment reference', async () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const first = node('rectangle', 50, 100, 50, 40)
  const reference = node('rectangle', 140, 108, 60, 45)
  const frame = node('frame', 300, 105, 95, 70)
  await render([first, reference, frame])
  await act(async () => editor.select([first.id, reference.id, frame.id]))
  const before = editor.authoredDocument, revision = editor.state.version
  const click = async (x: number, y: number) => {
    await act(async () => pointer('pointerdown', x, y))
    await act(async () => pointer('pointerup', x, y))
  }
  const marker = () => host().querySelector('[data-alignment-reference]')?.getAttribute('data-node-id')
  const xOf = (id: string) => editor.state.doc.nodes[id].transform[4]
  await click(158, 125)
  expect(editor.state.selection).toEqual([first.id, reference.id, frame.id])
  expect(marker()).toBe(reference.id)
  expect(editor.authoredDocument).toBe(before)
  expect(editor.state.version).toBe(revision)
  await act(async () => editor.align('x', 'start'))
  expect([xOf(first.id), xOf(reference.id), xOf(frame.id)]).toEqual([140, 140, 140])
  await act(async () => editor.undo())
  expect(editor.authoredDocument).toEqual(before)

  await click(339, 132)
  expect(marker()).toBe(frame.id)
  await act(async () => editor.align('x', 'end'))
  expect([xOf(first.id), xOf(reference.id), xOf(frame.id)]).toEqual([345, 335, 300])
  await act(async () => editor.undo())
  await click(777, 577)
  expect(marker()).toBeUndefined()
  expect(editor.state.alignmentReference).toBeUndefined()
  await act(async () => editor.select([first.id, reference.id]))
  await act(async () => editor.align('x', 'start'))
  expect([xOf(first.id), xOf(reference.id)]).toEqual([50, 50])
})

test('Sketch Option+Command drags the existing selection from elsewhere with one undo', async () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const parent = node('frame', 50, 50, 260, 230)
  const child = node('rectangle', 50, 55, 55, 60)
  const other = node('frame', 390, 50, 200, 210)
  parent.children = [child.id]
  await render([parent, child, other], [parent.id, other.id])
  await act(async () => editor.select([child.id]))
  const before = editor.authoredDocument, revision = editor.state.version
  const chord = { altKey: true, metaKey: true }
  const drag = async (from: [number, number], to: [number, number], mods: MouseEventInit, up = mods) => {
    await act(async () => pointer('pointerdown', ...from, mods))
    await act(async () => pointer('pointermove', ...to, mods))
    await flush()
    await act(async () => pointer('pointerup', ...to, up))
  }
  await drag([450, 125], [480, 145], chord, { altKey: true })
  expect(editor.state.selection).toEqual([child.id])
  expect(editor.state.doc.nodes[parent.id].children).toEqual([child.id])
  expect(editor.state.doc.nodes[other.id]).toBe(before.nodes[other.id])
  expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([80, 75])
  expect(Object.keys(editor.authoredDocument.nodes)).toHaveLength(3)
  expect(editor.state.version).toBe(revision + 1)
  await act(async () => editor.undo())
  expect(editor.authoredDocument).toEqual(before)
  expect(editor.canUndo).toBe(false)

  await drag([670, 365], [700, 385], { ...chord, shiftKey: true })
  expect(editor.state.doc.nodes[child.id].transform.slice(4)).toEqual([80, 55])
  await act(async () => editor.undo())
  for (const modifiers of [{ altKey: true }, { metaKey: true }]) {
    await act(async () => editor.select([child.id]))
    await drag([670, 365], [700, 385], modifiers)
    expect(editor.authoredDocument).toEqual(before)
  }
})

test('Sketch Shift+secondary click previews overlapping layers and selects only when a row is chosen', async () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const back = node('rectangle', 100, 100, 100, 100)
  const front = node('ellipse', 120, 120, 100, 100)
  const elsewhere = node('rectangle', 260, 100, 60, 60)
  back.name = 'Back paint'
  front.name = 'Front paint'
  await render([back, front, elsewhere])
  await act(async () => editor.select([elsewhere.id]))
  const before = editor.authoredDocument, revision = editor.state.version
  const context = (shiftKey: boolean) => act(async () => pointer('contextmenu', 160, 160, { button: 2, shiftKey }))
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
  const rows = () => [...menu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const hover = () => host().querySelector('[data-testid="canvas-hover-outline"]')?.getAttribute('data-node-id')

  await context(true)
  expect(rows().map(row => row.textContent)).toEqual(['Front paint', 'Back paint'])
  expect(editor.state.selection).toEqual([elsewhere.id])
  await act(async () => rows()[1].dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
  expect(hover()).toBe(back.id)
  expect(editor.state.selection).toEqual([elsewhere.id])
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(menu()).toBeNull()
  expect(hover()).toBeUndefined()
  expect(editor.state.selection).toEqual([elsewhere.id])

  await context(true)
  await act(async () => rows()[1].click())
  expect(editor.state.selection).toEqual([back.id])
  expect(menu()).toBeNull()
  expect(editor.authoredDocument).toBe(before)
  expect(editor.state.version).toBe(revision)
  expect(editor.canUndo).toBe(false)

  await context(false)
  expect(editor.state.selection).toEqual([front.id])
  expect(menu().querySelector('[data-layer-picker]')).not.toBeNull()
  expect(rows().length).toBeGreaterThan(2)
})

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
  // This is the rounding control, separate from the white resize handles.
  // A sharp rectangle needs it to start a corner drag at radius zero.
  expect(mount.querySelector('[data-testid="corner-radius-0"]')?.tagName).toBe('circle')
  expect(editor.state.doc.nodes[rect.id].radii).toEqual([0, 0, 0, 0])
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
  expect(mount.querySelector('[data-testid="canvas-hover-outline"]')).toBeNull()
  const pills = lines.flatMap(line => [...line.querySelectorAll('[data-pill="measure"]')].map(node => node.textContent))
  expect(pills).toEqual(expect.arrayContaining(['50', '40']))
  await act(async () => key('Alt', { altKey: false }, 'keyup'))
  expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
})

test('Sketch Control+Option measures the first cap above text and the last baseline below it', async () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const above = node('rectangle', 100, 80, 40, 20)
  const below = node('rectangle', 100, 340, 40, 20)
  const text = node('text', 100, 150, 120, 110)
  const shape = node('rectangle', 150, 40, 40, 24)
  text.text = 'H\nH'
  text.fontSize = 20
  text.textStyle = { ...defaultTextStyle(), verticalAlign: 'center' }
  await render([above, below, text, shape], undefined, 20)
  const before = editor.authoredDocument, revision = editor.state.version
  const actual = editor.state.doc.nodes[text.id]
  const { glyphs } = kernelTextLayout(actual)
  const cap = 150 + glyphs[0].y - 14.66 // Noto Sans SC cap height at 20 px.
  const baseline = 150 + glyphs[1].y
  const hover = async (x: number, y: number, ctrlKey = false) => {
    await act(async () => pointer('pointermove', x, y, { altKey: true, ctrlKey }))
    await flush()
  }
  const gap = () => {
    const line = mount.querySelector('[data-testid="canvas-measurement"] [data-measure="gap"]')!
    return ['y1','y2'].map(a => Number(line.getAttribute(a)))
  }
  const ctrl = async (pressed: boolean) => {
    await act(async () => key('Control', { altKey: true, ctrlKey: pressed }, pressed ? 'keydown' : 'keyup'))
  }

  await act(async () => editor.select([above.id]))
  await hover(110, 170)
  expect(gap()).toEqual([100, 150])
  await ctrl(true)
  expect(gap()[1]).toBeCloseTo(cap, 9)
  await ctrl(false)
  expect(gap()).toEqual([100, 150])

  await act(async () => editor.select([below.id]))
  await hover(110, 170)
  expect(gap()).toEqual([150 + actual.height, 340])
  await hover(110, 170, true)
  expect(gap()[0]).toBeCloseTo(baseline, 9)

  await hover(160, 50)
  const plainShape = gap()
  await ctrl(true)
  expect(gap()).toEqual(plainShape)
  await act(async () => interfacePreference.set({ uiMode: 'figma' }))
  await hover(110, 170, true)
  expect(gap()).toEqual([150 + actual.height, 340])
  expect(editor.authoredDocument).toBe(before)
  expect(editor.state.version).toBe(revision)
  expect(editor.canUndo).toBe(false)
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

const measurePills = () => [...mount.querySelectorAll('[data-testid="canvas-measurement"] [data-pill="measure"]')].map(node => node.textContent).sort()

test('Option hover on a partial overlap shows the matching-edge numbers', async () => {
  const selected = node('rectangle', 40, 40, 80, 40)
  const other = node('rectangle', 80, 50, 80, 40)
  await render([selected, other])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 100, 60, { altKey: true }))
  await flush()
  expect(measurePills()).toEqual(['10', '10', '40', '40'])
  expect(mount.querySelector('[data-testid="canvas-measurement"] [data-measure="gap"]')?.getAttribute('stroke')).toBe(SPACING_RED)
})

test('Dev Mode hover shows spacing without Option, and Shift D turns it off', async () => {
  const selected = node('rectangle', 40, 40, 50, 40)
  const sibling = node('rectangle', 140, 40, 40, 40)
  await render([selected, sibling])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 160, 55))
  await flush()
  expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
  await act(async () => key('D', { shiftKey: true, code: 'KeyD' }))
  expect(host().getAttribute('data-dev-mode')).toBe('on')
  await flush()
  expect(measurePills()).toEqual(expect.arrayContaining(['50', '40']))
  await act(async () => key('D', { shiftKey: true, code: 'KeyD' }))
  expect(host().getAttribute('data-dev-mode')).toBe('off')
  await flush()
  expect(mount.querySelector('[data-testid="canvas-measurement"]')).toBeNull()
})

test('keyboard pick keeps the original selection and Option measures to the highlight', async () => {
  const first = node('rectangle', 40, 40, 50, 40)
  const second = node('rectangle', 140, 40, 40, 40)
  await render([first, second])
  await act(async () => editor.select([first.id]))
  await act(async () => key(' ', { code: 'Space', altKey: true }))
  await act(async () => key('Tab'))
  await act(async () => key('Tab'))
  expect(editor.state.selection).toEqual([first.id])
  expect(mount.querySelector('[data-testid="keyboard-pick-outline"]')?.getAttribute('stroke')).toBe('#4597f7')
  await act(async () => key('Alt', { altKey: true }))
  expect(measurePills()).toEqual(expect.arrayContaining(['50', '40']))
  expect(editor.state.selection).toEqual([first.id])
})

test('Space repeats the distance under the pointer', async () => {
  const selected = node('rectangle', 40, 40, 50, 40)
  const sibling = node('rectangle', 140, 40, 40, 40)
  await render([selected, sibling])
  await act(async () => editor.select([selected.id]))
  await act(async () => pointer('pointermove', 160, 55, { altKey: true }))
  await flush()
  await act(async () => pointer('pointermove', 115, 60, { altKey: true }))
  await flush()
  await act(async () => key(' ', { code: 'Space' }))
  expect(mount.querySelector('[data-testid="measurement-announcement"]')?.textContent).toBe('50')
  expect(host().classList.contains('canvas-space-held')).toBe(false)
})

test('Option hover on a ruler guide measures from the selection, and a second guide shows positions', async () => {
  const layer = node('rectangle', 40, 40, 50, 40)
  await render([layer])
  await act(async () => {
    editor.change('参考线', document => { document.pages[0].guides = [
      { id: 'g1', axis: 'x', position: 200 },
      { id: 'g2', axis: 'x', position: 260 },
    ] })
    editor.set({ rulers: true })
    editor.select([layer.id])
  })
  const hit = (id: string) => mount.querySelector(`[data-guide-id="${id}"] line[stroke="transparent"]`)!
  await act(async () => key('Alt', { altKey: true }))
  await act(async () => pointer('pointerover', 200, 60, {}, hit('g1')))
  expect(measurePills()).toEqual(['110'])
  expect(mount.querySelector('[data-testid="canvas-measurement"] [data-measure="gap"]')).not.toBeNull()
  await act(async () => pointer('pointerdown', 200, 60, {}, hit('g1')))
  await act(async () => pointer('pointerup', 200, 60, {}, hit('g1')))
  await act(async () => pointer('pointerover', 260, 70, {}, hit('g2')))
  expect(measurePills()).toEqual(['200', '260'])
  expect(mount.querySelector('[data-testid="canvas-measurement"] line')).toBeNull()
})

test('vector edit Option-hover measures between anchors', async () => {
  const shape = node('vector', 100, 100, 80, 40)
  shape.network = {
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 80, y: 40 }],
    edges: [{ id: 'e', from: 'a', to: 'b' }],
    fillRule: 'nonzero',
  }
  await render([shape])
  await act(async () => { editor.select([shape.id]); editor.set({ tool: 'vector', editingVertex: 'a', editingVertices: ['a'] }) })
  await act(async () => key('Alt', { altKey: true }))
  const anchor = mount.querySelector('[data-vertex-id="b"]')!
  await act(async () => pointer('pointerover', 180, 140, {}, anchor))
  expect(measurePills()).toEqual(['40', '80'])
  expect(mount.querySelector('[data-testid="canvas-measurement"] [data-measure="gap"]')?.getAttribute('stroke')).toBe(SPACING_RED)
})
