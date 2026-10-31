// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, paint, stroke, effect, defaultTextStyle, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { scene, worldMatrix, apply } from './geometry'
import { dispatchEditorCommand } from './editor-commands'
import { insertInstance, stampKeys } from './components'

// React must detect DOM input event support before its module is evaluated.
// Match the existing real-text integration harness without suppressing errors.
const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()

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



for (const [command, expected] of [
  ['bring-forward', [0, 2, 1, 3]], ['send-backward', [1, 0, 2, 3]],
  ['bring-to-front', [0, 2, 3, 1]], ['send-to-back', [1, 0, 2, 3]],
] as const) test(`${command}: positive sibling ordering preserves transforms and one undo/redo`, async () => {
  const nodes = [0, 1, 2, 3].map(i => node('rectangle', 100 + i * 60, 100, 40, 40))
  await render(nodes); await act(async () => editor.select([nodes[1].id])); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, command) })
  expect(editor.state.doc.pages[0].children).toEqual(expected.map(i => nodes[i].id))
  for (const n of nodes) expect(worldMatrix(editor.state.doc, n.id)).toEqual(worldMatrix(before, n.id))
  const after = editor.state.doc; await act(async () => { await dispatchEditorCommand(editor, 'undo') }); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => { await dispatchEditorCommand(editor, 'redo') }); expect(editor.state.doc).toEqual(after)
})
test('flip-vertical: native command reflects world geometry around selection center with exact history', async () => {
  const parent = node('frame', 100, 100, 300, 300), child = node('rectangle', 30, 40, 80, 60)
  parent.transform = [0, 2, -2, 0, 600, 100]; parent.children = [child.id]
  await render([parent, child], [parent.id]); await act(async () => editor.select([child.id])); const before = editor.state.doc, matrix = worldMatrix(before, child.id), box = editor.selectionBounds()!
  await act(async () => { await dispatchEditorCommand(editor, 'flip-vertical') })
  const reflected = worldMatrix(editor.state.doc, child.id)
  expect(reflected[0]).toBeCloseTo(matrix[0], 10); expect(reflected[1]).toBeCloseTo(-matrix[1], 10)
  expect(reflected[2]).toBeCloseTo(matrix[2], 10); expect(reflected[3]).toBeCloseTo(-matrix[3], 10)
  expect(reflected[4]).toBeCloseTo(matrix[4], 10); expect(reflected[5]).toBeCloseTo(2 * box.y + box.height - matrix[5], 10)
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
for (const query of ['fill', 'stroke', 'effect', 'font', 'text', 'properties'] as const) test(`select-${query}: real dispatcher matches semantic values, excludes locked/hidden, does not author history`, async () => {
  const text = query === 'font' || query === 'text'
  const nodes = [0, 1, 2, 3, 4].map(i => node(text ? 'text' : 'rectangle', 100 + i * 80, 100, 50, 40))
  for (const n of nodes) {
    if (query === 'fill' || query === 'properties') n.fills = [paint('#123456')]
    if (query === 'stroke') n.strokes = [stroke('#123456', 4)]
    if (query === 'effect') n.effects = [effect('shadow')]
    if (text) { n.text = 'Same'; n.textStyle = { ...defaultTextStyle(), weight: 400 } }
  }
  if (query === 'fill') nodes[2].fills[0].color = '#ff0000'
  if (query === 'stroke') nodes[2].strokes[0].width = 9
  if (query === 'effect') nodes[2].effects[0].radius = 30
  if (query === 'font') nodes[2].textStyle!.weight = 700
  if (query === 'text') nodes[2].fontSize += 5
  if (query === 'properties') nodes[2].opacity = .5
  nodes[3].locked = true; nodes[4].visible = false
  await render(nodes); await act(async () => editor.select([nodes[0].id])); const before = editor.state.doc, version = editor.state.version
  await act(async () => { await dispatchEditorCommand(editor, `select-${query}`) })
  expect(editor.state.selection).toEqual([nodes[0].id, nodes[1].id]); expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
})
test('select-inverse: real dispatcher chooses only visible unlocked roots, no document/history mutation', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 200, 100, 40, 40), hidden = node('rectangle', 300, 100, 40, 40), locked = node('rectangle', 400, 100, 40, 40), group = node('group', 500, 100, 40, 40), child = node('rectangle', 0, 0, 40, 40)
  hidden.visible = false; locked.locked = true; group.children = [child.id]
  await render([a, b, hidden, locked, group, child], [a.id, b.id, hidden.id, locked.id, group.id]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'select-inverse') })
  expect(editor.state.selection).toEqual([b.id, group.id]); unchanged(before)
})
test('select-matching: real dispatcher resolves named child paths across frames, not unrelated names', async () => {
  const frames = [0, 1, 2].map(i => node('frame', 100 + i * 150, 100, 100, 100)), children = frames.map(() => node('rectangle', 10, 10, 30, 30))
  frames.forEach((f, i) => { f.children = [children[i].id]; children[i].name = i === 2 ? 'Other' : 'Icon' })
  await render([...frames, ...children], frames.map(f => f.id)); await act(async () => editor.select([children[0].id])); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'select-matching') })
  expect(editor.state.selection).toEqual([children[0].id, children[1].id]); unchanged(before)
})
test('select-instance: dispatcher selects same component instances, never the master or another component', async () => {
  const doc = blank(), master = node('frame', 0, 0, 40, 40), other = node('frame', 100, 0, 40, 40)
  for (const n of [master, other]) { n.component = { variants: {}, properties: {} }; doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); stampKeys(doc, n.id) }
  const a = insertInstance(doc, master.id, doc.pages[0].id, { x: 200, y: 100 }), b = insertInstance(doc, master.id, doc.pages[0].id, { x: 300, y: 100 })
  insertInstance(doc, other.id, doc.pages[0].id, { x: 400, y: 100 })
  await act(async () => { editor.load(doc); editor.select([a]) }); const before = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'select-instance') })
  expect(editor.state.selection).toEqual([a, b]); unchanged(before)
})
async function menuAction(label: string) {
  host().focus(); await act(async () => key('ContextMenu'))
  const button = document.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`)!
  expect(button).not.toBeNull(); expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(document.querySelector('[role="menu"]')).toBeNull()
}
test('actual Canvas menu group/ungroup preserve world geometry and restore each history boundary', async () => {
  const a = node('rectangle', 100, 100, 40, 40), b = node('rectangle', 180, 120, 60, 40)
  await render([a, b]); await act(async () => editor.select([a.id, b.id])); const before = editor.state.doc
  await menuAction('编组'); const grouped = editor.state.doc, id = editor.state.selection[0]
  expect(grouped.nodes[id].children).toEqual([a.id, b.id])
  for (const n of [a, b]) expect(worldMatrix(grouped, n.id)).toEqual(worldMatrix(before, n.id))
  await menuAction('解除编组'); const ungrouped = editor.state.doc; expect(ungrouped.nodes[id]).toBeUndefined()
  for (const n of [a, b]) expect(worldMatrix(ungrouped, n.id)).toEqual(worldMatrix(before, n.id))
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(grouped)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => { editor.redo(); editor.redo() }); expect(editor.state.doc).toEqual(ungrouped)
})
test('actual Canvas menu lock/unlock/hide/show are authored, individually reversible, and retain selection', async () => {
  const a = node('rectangle', 100, 100, 40, 40)
  await render([a]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  for (const [label, field, value] of [['锁定图层', 'locked', true], ['解锁图层', 'locked', false], ['隐藏图层', 'visible', false], ['显示图层', 'visible', true]] as const) {
    const previous = editor.state.doc
    await menuAction(label); expect(editor.state.doc.nodes[a.id][field]).toBe(value); expect(editor.state.selection).toEqual([a.id])
    const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(previous)
    await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
  }
  await act(async () => { for (let i = 0; i < 4; i++) editor.undo() }); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
})
