// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene } from './geometry'

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
let frames: Map<number, FrameRequestCallback>, frameId: number
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
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
  errors = []; const error = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); error(...args) })
  localStorage.clear(); shortcutPreference.set('sketch-like')
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})
const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = []) {
  const doc = blank('Selection workflows'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 6; i++) await Promise.resolve() })
  host().focus(); return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}, target: Element = host(), pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event); return event
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown', target: EventTarget = host()) {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
async function marquee(from: number[], to: number[], options: MouseEventInit = {}, downOptions = options) {
  await act(async () => pointer('pointerdown', from[0], from[1], downOptions))
  await act(async () => pointer('pointermove', to[0] - 20, to[1] - 20, downOptions))
  await act(async () => pointer('pointerup', to[0], to[1], options))
}
function unchanged(doc: typeof editor.state.doc) {
  expect(editor.state.doc).toBe(doc); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
}
const ordered = (values: string[]) => [...values].sort()

test('Sketch Option marquee uses final release bounds, full world AABB containment, and no history', async () => {
  const inside = node('rectangle', 100, 100, 30, 30), crossing = node('rectangle', 145, 100, 30, 30)
  const rotated = node('rectangle', 110, 160, 20, 20); rotated.transform = [Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, 120, 160]
  const doc = await render([inside, crossing, rotated])
  await marquee([80, 80], [160, 200], { altKey: true }, {})
  expect(ordered(editor.state.selection)).toEqual(ordered([inside.id, rotated.id])); unchanged(doc)
  await act(async () => editor.clearSelection())
  await marquee([80, 80], [160, 200], {}, { altKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([inside.id, crossing.id, rotated.id])); unchanged(doc)
  expect(scene(doc, doc.pages[0].id).find(e => e.id === rotated.id)!.bounds.width).toBeCloseTo(20 * Math.SQRT2, 12)
})

test.each(['MacIntel', 'Win32', 'Linux x86_64'])('Sketch Shift primary-modifier marquee toggles against its original selection on %s', async platform => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 150, 100, 30, 30), outside = node('rectangle', 500, 100, 30, 30)
  const doc = await render([a, b, outside]); await act(async () => editor.select([a.id, outside.id]))
  const mod = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true }
  await marquee([80, 80], [200, 150], { ...mod, shiftKey: true }, mod)
  expect(ordered(editor.state.selection)).toEqual(ordered([b.id, outside.id])); unchanged(doc)
  await marquee([80, 80], [200, 150], { ...mod, shiftKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, outside.id])); unchanged(doc)
})

test('deep contained marquee excludes hidden and locked ancestor paths while preserving mask selection AABB policy', async () => {
  const frame = node('frame', 100, 100, 250, 250), group = node('group', 10, 10, 150, 100), a = node('rectangle', 10, 10, 30, 30)
  const hidden = node('group', 50, 10, 80, 80), h = node('rectangle', 0, 0, 20, 20), locked = node('group', 90, 10, 80, 80), l = node('rectangle', 0, 0, 20, 20)
  const mask = node('rectangle', 10, 70, 20, 20), clipped = node('rectangle', 40, 70, 20, 20)
  hidden.visible = false; locked.locked = true; mask.mask = true
  frame.children = [group.id]; group.children = [a.id, hidden.id, locked.id, mask.id, clipped.id]; hidden.children = [h.id]; locked.children = [l.id]
  const doc = await render([frame, group, a, hidden, h, locked, l, mask, clipped], [frame.id])
  await marquee([80, 80], [270, 230], { metaKey: true, altKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, mask.id, clipped.id])); unchanged(doc)
})

test('held X overrides an occupied frame, reaches nested children, and preserves the current drawing tool', async () => {
  const frame = node('frame', 100, 100, 300, 250), group = node('group', 20, 20, 200, 150), a = node('rectangle', 30, 30, 30, 30), b = node('rectangle', 90, 30, 30, 30)
  frame.children = [group.id]; group.children = [a.id, b.id]
  const doc = await render([frame, group, a, b], [frame.id]); await act(async () => editor.set({ tool: 'rectangle' }))
  await act(async () => { key('x'); key('x', { repeat: true }) })
  expect(host().style.cursor).toBe('crosshair')
  await marquee([110, 110], [270, 210])
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, b.id])); expect(editor.state.tool).toBe('rectangle'); unchanged(doc)
  await act(async () => key('x', {}, 'keyup')); expect(host().style.cursor).not.toBe('crosshair')
})

test('held X intercepts actual resize handles and excludes the starting leaf without modifying geometry', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 170, 100, 30, 30)
  const doc = await render([a, b]); await act(async () => editor.select([a.id])); await act(async () => key('x'))
  const handle = mount.querySelector('[data-testid="resize-0"]')!; expect(handle).not.toBeNull()
  await act(async () => pointer('pointerdown', 100, 100, {}, handle))
  await act(async () => pointer('pointerup', 220, 160))
  expect(editor.state.selection).toEqual([b.id]); unchanged(doc)
})

test.each(['keyup', 'blur', 'visibility', 'editable-focus'])('held X clears on %s and the next ordinary drag still moves a layer', async release => {
  const a = node('rectangle', 100, 100, 50, 50), doc = await render([a])
  await act(async () => { key('x'); key('x', { repeat: true }) })
  await act(async () => {
    if (release === 'keyup') key('x', {}, 'keyup')
    if (release === 'blur') window.dispatchEvent(new Event('blur'))
    if (release === 'visibility') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) }
    if (release === 'editable-focus') { const field = document.createElement('input'); document.body.append(field); field.focus(); field.remove(); host().focus() }
  })
  expect(host().style.cursor).not.toBe('crosshair')
  await marquee([120, 120], [160, 150])
  expect(editor.state.doc.nodes[a.id].transform.slice(4)).toEqual([140, 130]); expect(editor.canUndo).toBe(true)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(doc)
})

test('IME, text fields, contenteditable, modal dialogs, and foreign modifiers never arm X', async () => {
  const a = node('rectangle', 100, 100, 40, 40), doc = await render([a]); await act(async () => editor.set({ tool: 'rectangle' }))
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    await act(async () => key('x', options)); expect(host().style.cursor).not.toBe('crosshair')
  }
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const field = document.createElement(tag); if (tag === 'div') field.contentEditable = 'true'
    if (tag === 'div') field.setAttribute('contenteditable', 'true')
    document.body.append(field); await act(async () => key('x', {}, 'keydown', field)); field.remove()
    expect(host().style.cursor).not.toBe('crosshair')
  }
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal)
  await act(async () => key('x')); modal.remove(); expect(host().style.cursor).not.toBe('crosshair')
  expect(editor.state.tool).toBe('rectangle'); unchanged(doc)
})

test('Sketch Escape walks parents, then deselects roots; Figma Escape and Shift+Enter retain their existing meanings', async () => {
  const frame = node('frame', 100, 100, 200, 200), group = node('group', 10, 10, 100, 100), a = node('rectangle', 10, 10, 30, 30)
  frame.children = [group.id]; group.children = [a.id]; const doc = await render([frame, group, a], [frame.id])
  await act(async () => editor.select([a.id]))
  for (const selected of [[group.id], [frame.id], []]) { await act(async () => key('Escape')); expect(editor.state.selection).toEqual(selected) }
  await act(async () => { editor.select([a.id]); shortcutPreference.set('figma-like') })
  await act(async () => key('Escape')); expect(editor.state.selection).toEqual([])
  await act(async () => editor.select([a.id])); await act(async () => key('Enter', { shiftKey: true })); expect(editor.state.selection).toEqual([group.id])
  unchanged(doc)
})

test('Sketch Escape cancels an active move and drawing tool before parent navigation', async () => {
  const frame = node('frame', 100, 100, 250, 250), a = node('rectangle', 20, 20, 50, 50); frame.children = [a.id]
  const doc = await render([frame, a], [frame.id]); await act(async () => editor.select([a.id]))
  await act(async () => pointer('pointerdown', 140, 140)); await act(async () => pointer('pointermove', 180, 170))
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(performance.now()) } })
  expect(editor.interactionActive).toBe(true) // Retained SVG move may deliberately keep the document unchanged until release.
  await act(async () => key('Escape')); expect(editor.state.doc).toBe(doc); expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
  await act(async () => pointer('pointerup', 180, 170)); unchanged(doc)
  await act(async () => editor.set({ tool: 'rectangle' })); await act(async () => key('Escape'))
  expect(editor.state.tool).toBe('select'); expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
  await act(async () => key('Escape')); expect(editor.state.selection).toEqual([frame.id])
})

test('Figma Option marquee remains intersection-based and Shift remains additive; Sketch drag keeps its start profile', async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 145, 100, 30, 30), doc = await render([a, b])
  await act(async () => { shortcutPreference.set('figma-like'); editor.select([a.id]) })
  await marquee([80, 80], [160, 150], { altKey: true, shiftKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, b.id])); unchanged(doc)
  await act(async () => { shortcutPreference.set('sketch-like'); editor.clearSelection() })
  await act(async () => pointer('pointerdown', 80, 80))
  await act(async () => shortcutPreference.set('figma-like'))
  await act(async () => pointer('pointerup', 160, 150, { altKey: true }))
  expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
})

test('Figma click stays on the frame, Shift during the marquee adds, and a short drag does not select', async () => {
  const frame = node('frame', 80, 80, 220, 160), child = node('rectangle', 20, 20, 40, 30)
  const other = node('rectangle', 400, 80, 30, 30)
  frame.children = [child.id]
  const doc = await render([frame, child, other], [frame.id, other.id])
  await act(async () => shortcutPreference.set('figma-like'))
  await act(async () => pointer('pointerdown', 110, 110))
  await act(async () => pointer('pointerup', 110, 110))
  expect(editor.state.selection).toEqual([frame.id]); unchanged(doc)
  await act(async () => host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 110, clientY: 110 })))
  expect(editor.state.selection).toEqual([child.id]); unchanged(doc)
  await act(async () => key('Enter', { shiftKey: true }))
  expect(editor.state.selection).toEqual([frame.id]); unchanged(doc)
  await marquee([20, 20], [22, 22])
  expect(editor.state.selection).toEqual([]); unchanged(doc)
  await act(async () => editor.select([other.id]))
  await marquee([70, 70], [320, 260], { shiftKey: true }, {})
  expect(ordered(editor.state.selection)).toEqual(ordered([frame.id, other.id])); unchanged(doc)
  await act(async () => pointer('pointerdown', 110, 110, { metaKey: true }))
  await act(async () => pointer('pointerup', 110, 110, { metaKey: true }))
  expect(editor.state.selection).toEqual([child.id]); unchanged(doc)
})

test('held X clears on profile and document changes without becoming a persistent selection tool', async () => {
  const a = node('rectangle', 100, 100, 40, 40); await render([a]); await act(async () => editor.set({ tool: 'rectangle' }))
  await act(async () => key('x')); expect(host().style.cursor).toBe('crosshair')
  await act(async () => shortcutPreference.set('figma-like')); expect(host().style.cursor).not.toBe('crosshair')
  await act(async () => { shortcutPreference.set('sketch-like'); key('x') }); expect(host().style.cursor).toBe('crosshair')
  await act(async () => editor.load(blank('New document'))); expect(host().style.cursor).not.toBe('crosshair')
  expect(editor.state.doc.name).toBe('New document'); expect(editor.state.selection).toEqual([])
})

test('X cannot seize Mac Control-click native context selection or a second pointer', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 170, 100, 30, 30), doc = await render([a, b])
  await act(async () => { editor.select([a.id]); key('x') })
  let controlClick!: MouseEvent
  await act(async () => { controlClick = pointer('pointerdown', 110, 110, { ctrlKey: true }) })
  expect(controlClick.defaultPrevented).toBe(false); expect(editor.interactionActive).toBe(false)
  await act(async () => pointer('pointerup', 220, 160, { ctrlKey: true })); expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
  await act(async () => pointer('pointerdown', 110, 110))
  await act(async () => pointer('pointerup', 220, 160, {}, host(), 8)); expect(editor.state.selection).toEqual([a.id])
  await act(async () => pointer('pointerup', 220, 160)); expect(editor.state.selection).toEqual([b.id]); unchanged(doc)
})

test('held X from a drawing tool intercepts a previously mounted handle and release-only coordinates', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 170, 100, 30, 30), doc = await render([a, b])
  await act(async () => editor.select([a.id]))
  const handle = mount.querySelector('[data-testid="resize-0"]')!; expect(handle).not.toBeNull()
  // Same browser turn: X must read current editor state even when React has not
  // yet removed selection-tool handles after this tool change.
  await act(async () => {
    editor.set({ tool: 'rectangle' }); key('x'); pointer('pointerdown', 100, 100, {}, handle)
  })
  await act(async () => pointer('pointerup', 220, 160))
  expect(editor.state.selection).toEqual([b.id]); expect(editor.state.tool).toBe('rectangle'); unchanged(doc)
})

test('Sketch Option containment stays world-accurate under pan, zoom, and reverse-direction marquee', async () => {
  const a = node('rectangle', 100.125, 100.25, 30.5, 30.25), b = node('rectangle', 145, 100, 30, 30), doc = await render([a, b])
  await act(async () => editor.set({ view: { x: -35.5, y: 15.25, zoom: 2.5 } }))
  const screen = (x: number, y: number) => [x * 2.5 - 35.5, y * 2.5 + 15.25]
  await marquee(screen(160, 150), screen(80, 80), { altKey: true })
  expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
})

test('Sketch Shift toggles shallow candidates too, while removing Shift before release replaces selection', async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 150, 100, 30, 30), outside = node('rectangle', 500, 100, 30, 30), doc = await render([a, b, outside])
  await act(async () => editor.select([a.id, outside.id]))
  await marquee([80, 80], [200, 150], { shiftKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([b.id, outside.id])); unchanged(doc)
  await marquee([80, 80], [200, 150], {}, { shiftKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, b.id])); unchanged(doc)
})

test('selection-only Escape and marquees preserve an existing undo/redo chain', async () => {
  const frame = node('frame', 100, 100, 250, 250), a = node('rectangle', 20, 20, 30, 30); frame.children = [a.id]
  await render([frame, a], [frame.id]); await act(async () => editor.update([a.id], { width: 55 }, 'Existing change'))
  await act(async () => editor.undo()); const before = editor.state.doc
  await act(async () => editor.select([a.id])); await act(async () => key('Escape'))
  expect(editor.state.selection).toEqual([frame.id]); expect(editor.state.doc).toBe(before)
  await act(async () => editor.clearSelection()); await marquee([80, 80], [200, 200], { metaKey: true, altKey: true })
  expect(editor.state.selection).toEqual([a.id]); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[a.id].width).toBe(55)
})

test('cancelled forced marquees and document replacement cannot commit a stale selection', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 170, 100, 30, 30), doc = await render([a, b])
  await act(async () => { editor.select([a.id]); key('x') })
  await act(async () => pointer('pointerdown', 110, 110))
  await act(async () => pointer('pointercancel', 220, 160))
  await act(async () => pointer('pointerup', 220, 160)); expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
  await act(async () => pointer('pointerdown', 110, 110))
  await act(async () => editor.load(blank('Replacement')))
  const replacement = editor.state.doc
  await act(async () => pointer('pointerup', 220, 160)); expect(editor.state.selection).toEqual([]); unchanged(replacement)
})

test.each(['group', 'frame'] as const)('forced X cannot promote the ignored starting leaf into its %s; independent siblings stay eligible', async kind => {
  const container = node(kind, 100, 100, 200, 160), a = node('rectangle', 10, 10, 40, 40), b = node('rectangle', 220, 120, 25, 25)
  container.children = [a.id]; const doc = await render([container, a, b], [container.id, b.id])
  await act(async () => key('x'))
  await marquee([120, 120], [135, 135]); expect(editor.state.selection).toEqual([]); unchanged(doc)
  await marquee([120, 120], [260, 165]); expect(editor.state.selection).toEqual([b.id]); unchanged(doc)
})

test.each(['MacIntel', 'Win32', 'Linux x86_64'])('actual Sketch desktop primary+3 centers selection without zoom or history on %s', async platform => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, onCommand: () => () => {} } })
  const a = node('rectangle', 100.25, 200.5, 80.5, 40.25), doc = await render([a])
  await act(async () => { editor.select([a.id]); editor.setViewCoalesced({ x: 31.5, y: -27.25, zoom: 2.75 }) })
  const bounds = editor.selectionBounds()!, mod = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true }
  let event!: KeyboardEvent
  await act(async () => { event = key('3', { code: 'Digit3', ...mod }) })
  expect(event.defaultPrevented).toBe(true)
  expect(editor.state.view).toEqual({ zoom: 2.75,
    x: 500 - (bounds.x + bounds.width / 2) * 2.75, y: 400 - (bounds.y + bounds.height / 2) * 2.75 })
  expect(editor.state.selection).toEqual([a.id]); unchanged(doc)
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(performance.now()) } })
  expect(editor.state.view.zoom).toBe(2.75); unchanged(doc)
})

test('browser primary+3 and Figma desktop primary+3 remain unclaimed browser/system chords', async () => {
  const a = node('rectangle', 100, 200, 80, 40), doc = await render([a])
  await act(async () => { editor.select([a.id]); editor.set({ view: { x: 13, y: 29, zoom: 1.75 } }) })
  const view = editor.state.view; let event!: KeyboardEvent
  await act(async () => { event = key('3', { code: 'Digit3', metaKey: true }) })
  expect(event.defaultPrevented).toBe(false); expect(editor.state.view).toEqual(view)
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, onCommand: () => () => {} } })
  await act(async () => shortcutPreference.set('figma-like'))
  await act(async () => { event = key('3', { code: 'Digit3', metaKey: true }) })
  expect(event.defaultPrevented).toBe(false); expect(editor.state.view).toEqual(view); unchanged(doc)
})

test('desktop center shortcut respects empty selection, repeated/IME/modifier/input guards and existing history', async () => {
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, onCommand: () => () => {} } })
  const a = node('rectangle', 100, 200, 80, 40), hidden = node('rectangle', 500, 200, 80, 40), locked = node('rectangle', 600, 200, 80, 40), foreign = node('rectangle', 800, 200, 80, 40)
  hidden.visible = false; locked.locked = true
  await render([a, hidden, locked, foreign], [a.id, hidden.id, locked.id], [foreign.id])
  const view = editor.state.view
  await act(async () => key('3', { code: 'Digit3', metaKey: true })); expect(editor.state.view).toEqual(view)
  for (const selected of [hidden.id, foreign.id, 'stale-selection-id']) {
    await act(async () => editor.select([selected]))
    await act(async () => key('3', { code: 'Digit3', metaKey: true })); expect(editor.state.view).toEqual(view)
  }
  await act(async () => editor.select([locked.id]))
  await act(async () => key('3', { code: 'Digit3', metaKey: true }))
  expect(editor.state.view).toEqual({ x: 500 - 640, y: 400 - 220, zoom: 1 })
  await act(async () => { editor.set({ view }); editor.select([a.id]) })
  for (const options of [{ repeat: true }, { isComposing: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: true }]) {
    await act(async () => key('3', { code: 'Digit3', metaKey: true, ...options })); expect(editor.state.view).toEqual(view)
  }
  await act(async () => { editor.set({ busy: true }); key('3', { code: 'Digit3', metaKey: true }) }); expect(editor.state.view).toEqual(view)
  await act(async () => { editor.set({ busy: false }); editor.begin('Center guard'); key('3', { code: 'Digit3', metaKey: true }) }); expect(editor.state.view).toEqual(view)
  await act(async () => editor.cancel())
  const input = document.createElement('input'); document.body.append(input); await act(async () => input.focus())
  await act(async () => key('3', { code: 'Digit3', metaKey: true }, 'keydown', input)); expect(editor.state.view).toEqual(view)
  await act(async () => { input.remove(); host().focus() })
  await act(async () => editor.update([a.id], { width: 120 }, 'Existing width change'))
  await act(async () => editor.undo()); const doc = editor.state.doc
  await act(async () => key('3', { code: 'Digit3', metaKey: true })); expect(editor.state.view.zoom).toBe(view.zoom)
  expect(editor.state.doc).toBe(doc); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[a.id].width).toBe(120)
})

test('entered-frame click hits the front sibling and a drag moves only that sibling', async () => {
  const frame = node('frame', 0, 0, 400, 300), child = node('rectangle', 40, 40, 40, 30), backing = node('rectangle', 20, 20, 300, 200)
  frame.children = [child.id, backing.id]
  const before = await render([frame, child, backing], [frame.id])
  await act(async () => editor.select([child.id]))
  await act(async () => pointer('pointerdown', 50, 50))
  expect(editor.state.selection).toEqual([backing.id])
  await act(async () => pointer('pointerup', 50, 50))
  unchanged(before)
  await act(async () => pointer('pointerdown', 50, 50))
  await act(async () => pointer('pointermove', 55, 55))
  await act(async () => pointer('pointerup', 70, 80))
  expect(editor.state.selection).toEqual([backing.id])
  expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  expect(editor.state.doc.nodes[backing.id].transform).toEqual([1, 0, 0, 1, 40, 50])
  expect(editor.state.doc.nodes[frame.id]).toEqual(before.nodes[frame.id])
  expect(editor.interactionActive).toBe(false)
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
  await act(async () => editor.select([child.id, backing.id]))
  await act(async () => pointer('pointerdown', 70, 80, { shiftKey: true }))
  await act(async () => pointer('pointerup', 70, 80, { shiftKey: true }))
  expect(editor.state.selection).toEqual([child.id])
})
