// Mounted Canvas and Inspector. The device boundary is replaced; pixels are
// checked by the native kernel test, not by this jsdom surface.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { Editor } from './engine'
import { apply, inverse, worldMatrix } from './geometry'
import { blank, effect, node, type DesignNode } from './model'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'

const bootstrap = await vi.hoisted(async () => {
  // React's input listener is chosen once, when this module first loads.
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const early = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator'] as const)
    vi.stubGlobal(key, key === 'window' ? early.window : early.window[key])
  return early
})
bootstrap.window.close()

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

type BlurEdit = {
  session: number; document: string; page: string; node: string; index: number; effect: string; count: number
}

/** Same session fence App uses before it shows blur handles. */
function activeBlurIndex(edit: BlurEdit | null, editor: Editor, snap: ReturnType<Editor['panelSnapshot']>) {
  const node = edit && snap.doc.nodes[edit.node]
  const fx = edit && node && node.effects[edit.index]
  return edit && node && fx?.visible && (fx.gradientBlur || fx.zoomBlur)
    && edit.session === editor.sessionGeneration && edit.document === snap.doc.id && edit.page === snap.page
    && snap.tool === 'select' && snap.selection.length === 1 && snap.selection[0] === edit.node
    && node.effects.length === edit.count && fx.id === edit.effect
    ? edit.index : undefined
}

function Studio({ editor, exits }: { editor: Editor; exits: { count: number } }) {
  const snap = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const [edit, setEdit] = useState<BlurEdit | null>(null)
  const index = activeBlurIndex(edit, editor, snap)
  useEffect(() => { if (edit && index === undefined) setEdit(null) }, [edit, index])
  const editBlur = (next: number | null) => {
    if (next === null) { setEdit(null); return }
    const state = editor.state
    const node = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined
    const fx = node?.effects[next]
    if (state.tool !== 'select' || editor.interactionActive || !node || !fx?.visible || !(fx.gradientBlur || fx.zoomBlur)) return
    setEdit({ session: editor.sessionGeneration, document: state.doc.id, page: state.page,
      node: node.id, index: next, effect: fx.id, count: node.effects.length })
  }
  return <>
    <Canvas editor={editor} blurEffectIndex={index} onExitBlurEdit={() => { exits.count += 1; setEdit(null) }} />
    <PendingEditContext.Provider value={editor}>
      <Inspector editor={editor} blurEffectIndex={index} onEditBlur={editBlur} />
    </PendingEditContext.Provider>
  </>
}

let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][], exits: { count: number }
let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'WheelEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage', 'SVGElement'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => true
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  localStorage.clear(); interfacePreference.reset(); shortcutPreference.set('figma-like')
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  exits = { count: 0 }
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
function pointer(type: string, x: number, y: number, target: Element = host(), pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: 'mouse' }, buttons: { value: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 } })
  target.dispatchEvent(event)
}
async function flush() {
  await act(async () => {
    const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(performance.now()))
  })
}
function screen(point: { x: number; y: number }) {
  const view = editor.state.view
  return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y }
}
async function show(nodes: DesignNode[], roots: string[]) {
  const doc = blank('模糊编辑'); doc.schemaVersion = 19
  doc.nodes = Object.fromEntries(nodes.map(node => [node.id, node]))
  doc.pages[0].children = roots
  editor.load(doc)
  editor.set({ view: { x: 17, y: -11, zoom: 2 }, snap: false, snapPixels: false, tool: 'select' })
  await act(async () => { root.render(<Studio editor={editor} exits={exits} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus()
  return editor.state.doc
}
function button(label: string) {
  return [...mount.querySelectorAll('button')].find(item => item.textContent?.includes(label)) as HTMLButtonElement | undefined
}
function field(label: string) {
  return mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
}
async function enterEdit() {
  const control = button('在画布上编辑模糊')
  expect(control).toBeTruthy()
  await act(async () => control!.click())
}
function endpoint(id: string, which: 'start' | 'end') {
  return editor.state.doc.nodes[id].effects[0].gradientBlur![which]
}

function posedRectangle() {
  const flip = node('group', 0, 0, 320, 240)
  flip.transform = [-1, 0, 0, 1, 480, 24]
  const turn = node('group', 0, 0, 180, 140)
  turn.transform = [0, 1, -1, 0, 36, 18]
  const shape = node('rectangle', 12, 8, 120, 80)
  shape.radii = [6, 6, 6, 6]
  const blur = effect('blur')
  blur.radius = 4
  blur.opacity = 1
  blur.gradientBlur = { start: [10, 40], end: [100, 28], startCount: 1, endCount: 5, smooth: true }
  shape.effects = [blur, effect('glass')]
  const other = node('rectangle', 40, 40, 30, 30)
  flip.children = [turn.id]
  turn.children = [shape.id]
  return { flip, turn, shape, other }
}

test('gradient endpoints drag in a flipped rotated nest, stay in sync, and undo once', async () => {
  const { flip, turn, shape, other } = posedRectangle()
  const before = await show([flip, turn, shape, other], [flip.id, other.id])
  await act(async () => editor.select([shape.id]))
  expect(mount.querySelector('[data-testid="blur-edit-handles"]')).toBeNull()
  expect(mount.querySelector('[data-testid="corner-radius-0"]')).toBeTruthy()
  expect(mount.querySelector('[data-testid="glass-light-handle"]')).toBeTruthy()
  await enterEdit()
  expect(button('完成画布编辑')).toBeTruthy()
  expect(mount.querySelector('[data-testid="corner-radius-0"]')).toBeNull()
  expect(mount.querySelector('[data-testid="glass-light-handle"]')).toBeNull()
  const handle = mount.querySelector('[data-testid="blur-end-handle"]')!
  expect(handle).toBeTruthy()
  const world = { x: Number(handle.getAttribute('cx')), y: Number(handle.getAttribute('cy')) }
  const matrix = worldMatrix(editor.state.doc, shape.id)
  expect(apply(matrix, { x: 100, y: 28 }).x).toBeCloseTo(world.x, 6)
  expect(apply(matrix, { x: 100, y: 28 }).y).toBeCloseTo(world.y, 6)
  const end = { x: world.x + 18, y: world.y - 7 }
  const down = screen(world), up = screen(end)
  await act(async () => pointer('pointerdown', down.x, down.y, handle))
  await act(async () => pointer('pointermove', up.x, up.y))
  await flush()
  const local = apply(inverse(matrix), end)
  const origin = apply(inverse(matrix), world)
  const expected: [number, number] = [100 + local.x - origin.x, 28 + local.y - origin.y]
  expect(endpoint(shape.id, 'end')[0]).toBeCloseTo(expected[0], 6)
  expect(endpoint(shape.id, 'end')[1]).toBeCloseTo(expected[1], 6)
  expect(endpoint(shape.id, 'start')).toEqual([10, 40])
  expect(field('终点 X')!.value).toBe(String(Number(endpoint(shape.id, 'end')[0].toFixed(2))))
  expect(field('终点 Y')!.value).toBe(String(Number(endpoint(shape.id, 'end')[1].toFixed(2))))
  expect(editor.state.doc.nodes[shape.id].radii).toEqual([6, 6, 6, 6])
  expect(editor.state.doc.nodes[shape.id].effects[1].glass!.lightAngle).toBe(45)
  await act(async () => pointer('pointerup', up.x, up.y))
  const dragged = editor.state.doc
  expect(editor.canUndo).toBe(true)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[shape.id].effects[0].gradientBlur).toEqual(before.nodes[shape.id].effects[0].gradientBlur)
  expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo())
  expect(editor.state.doc).toEqual(dragged)
  const input = field('终点 X')!
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '42.5')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(endpoint(shape.id, 'end')[0]).toBeCloseTo(42.5, 6)
  await act(async () => editor.undo())
  expect(endpoint(shape.id, 'end')[0]).toBeCloseTo(expected[0], 6)
  await act(async () => editor.undo())
  expect(editor.state.doc.nodes[shape.id].effects[0].gradientBlur).toEqual(before.nodes[shape.id].effects[0].gradientBlur)
})

test('zoom focus follows the same pose at another zoom, and Esc or pointer cancel ends cleanly', async () => {
  const { flip, turn, shape, other } = posedRectangle()
  shape.effects = [effect('zoom-blur'), effect('glass')]
  shape.effects[0].zoomBlur = { amount: 18, center: [0.25, 0.75] }
  const before = await show([flip, turn, shape, other], [flip.id, other.id])
  await act(async () => { editor.select([shape.id]); editor.set({ view: { x: -40, y: 22, zoom: 0.5 } }) })
  await enterEdit()
  const handle = mount.querySelector('[data-testid="zoom-blur-origin-handle"]')!
  expect(handle).toBeTruthy()
  expect(mount.querySelector('[data-testid="blur-end-handle"]')).toBeNull()
  expect(mount.querySelector('[data-testid="glass-light-handle"]')).toBeNull()
  const world = { x: Number(handle.getAttribute('cx')), y: Number(handle.getAttribute('cy')) }
  const matrix = worldMatrix(before, shape.id)
  expect(apply(matrix, { x: 0.25 * 120, y: 0.75 * 80 }).x).toBeCloseTo(world.x, 5)
  const end = { x: world.x - 11, y: world.y + 6 }
  const down = screen(world), up = screen(end)
  await act(async () => pointer('pointerdown', down.x, down.y, handle))
  await act(async () => pointer('pointermove', up.x, up.y))
  await flush()
  const local = apply(inverse(matrix), end), origin = apply(inverse(matrix), world)
  const center = editor.state.doc.nodes[shape.id].effects[0].zoomBlur!.center
  expect(center[0]).toBeCloseTo(0.25 + (local.x - origin.x) / 120, 6)
  expect(center[1]).toBeCloseTo(0.75 + (local.y - origin.y) / 80, 6)
  expect(field('焦点 X %')!.value).toBe(String(Number((center[0] * 100).toFixed(2))))
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
  })
  expect(editor.state.doc.nodes[shape.id].effects[0].zoomBlur).toEqual(before.nodes[shape.id].effects[0].zoomBlur)
  expect(editor.canUndo).toBe(false)
  expect(exits.count).toBe(1)
  expect(mount.querySelector('[data-testid="zoom-blur-origin-handle"]')).toBeNull()
  expect(mount.querySelector('[data-testid="glass-light-handle"]')).toBeTruthy()

  await enterEdit()
  const again = mount.querySelector('[data-testid="zoom-blur-origin-handle"]')!
  const start = { x: Number(again.getAttribute('cx')), y: Number(again.getAttribute('cy')) }
  const moved = { x: start.x + 8, y: start.y + 4 }
  const from = screen(start), to = screen(moved)
  await act(async () => pointer('pointerdown', from.x, from.y, again))
  await act(async () => pointer('pointermove', to.x, to.y))
  await flush()
  expect(editor.state.doc.nodes[shape.id].effects[0].zoomBlur).not.toEqual(before.nodes[shape.id].effects[0].zoomBlur)
  const exitsBefore = exits.count
  await act(async () => pointer('pointercancel', to.x, to.y))
  expect(editor.state.doc.nodes[shape.id].effects[0].zoomBlur).toEqual(before.nodes[shape.id].effects[0].zoomBlur)
  expect(editor.canUndo).toBe(false)
  expect(exits.count).toBe(exitsBefore)
  expect(mount.querySelector('[data-testid="zoom-blur-origin-handle"]')).toBeTruthy()

  await act(async () => editor.select([other.id]))
  expect(mount.querySelector('[data-testid="zoom-blur-origin-handle"]')).toBeNull()
  expect(button('在画布上编辑模糊')).toBeUndefined()
  expect(mount.querySelector('[data-testid="corner-radius-0"]')).toBeTruthy()
})
