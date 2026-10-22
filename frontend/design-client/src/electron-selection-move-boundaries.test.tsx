// Actual mounted Canvas/event propagation + Editor/WASM. Only the render-device
// boundary is replaced; no native browser, GPU, or pixel-quality claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, uid, paint, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { worldMatrix, apply } from './geometry'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'

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
  localStorage.clear(); shortcutPreference.set('figma-like'); interfacePreference.reset(); nudgePreference.reset()
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
  await act(async () => { root.render(<Harness />); for (let i = 0; i < 6; i++) await Promise.resolve() })
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

// Native event routing and real Editor/WASM; Surface presentation only is doubled.
// These are not OS GUI or independent Figma-observed claims.
function Harness() {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  return <><Canvas editor={editor} /><PendingEditContext.Provider value={editor}>
    <MultiSelectionInspector editor={editor} nodes={state.selection.map(id => state.doc.nodes[id])} />
  </PendingEditContext.Provider></>
}
function screen(x: number, y: number) { const v = editor.state.view; return [x * v.zoom + v.x, y * v.zoom + v.y] }
function center(id: string) { const n = editor.state.doc.nodes[id]; return apply(worldMatrix(editor.state.doc, id), { x: n.width / 2, y: n.height / 2 }) }
async function drag(id: string, dx: number, dy: number, end: 'pointerup' | 'pointercancel' | 'Escape' = 'pointerup') {
  const p = center(id), from = screen(p.x, p.y), to = screen(p.x + dx, p.y + dy)
  await act(async () => pointer('pointerdown', from[0], from[1]))
  await act(async () => pointer('pointermove', to[0], to[1]))
  await act(async () => end === 'Escape' ? key('Escape') : pointer(end, to[0], to[1]))
}
function delta(before: typeof editor.state.doc, id: string, x: number, y: number) {
  const a = worldMatrix(before, id), b = worldMatrix(editor.state.doc, id)
  for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(a[i], 8)
  expect(b[4]).toBeCloseTo(a[4] + x, 7); expect(b[5]).toBeCloseTo(a[5] + y, 7)
}
function rotate(n: DesignNode, degrees: number) { const r = degrees * Math.PI / 180; n.transform = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), n.transform[4], n.transform[5]] }
async function oneHistory(before: typeof editor.state.doc) {
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after); expect(editor.canRedo).toBe(false)
}
async function redoSeed(id: string) {
  await act(async () => { editor.updateProperties([id], { name: 'Redo survives navigation' }); editor.undo() })
  expect(editor.canRedo).toBe(true); return editor.state.doc
}
async function menuAction(label: string) {
  await act(async () => { host().focus(); key('ContextMenu') })
  if (label === '反选') {
    const submenu = document.querySelector<HTMLButtonElement>('[role="menuitem"][data-menu-group="selection"]')
    expect(submenu).not.toBeNull(); await act(async () => submenu!.click())
  }
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item =>
    item.getAttribute('aria-label') === label || item.querySelector('.context-label')?.textContent === label)
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click()); expect(document.querySelector('[role="menu"]')).toBeNull()
}
for (const zoom of [.5, 2]) test(`S01 nested rotated hit and release-only delta at zoom ${zoom} with pan`, async () => {
  const outer = node('frame', 200, 100, 400, 300), inner = node('frame', 30, 30, 300, 220)
  const backing = node('rectangle', 0, 0, 250, 180), child = node('rectangle', 40, 40, 40, 30)
  rotate(outer, 20); rotate(inner, -10); outer.children = [inner.id]; inner.children = [backing.id, child.id]
  await render([outer, inner, backing, child], [outer.id]); await act(async () => { editor.select([child.id]); editor.set({ view: { x: 35, y: 45, zoom } }) })
  const before = editor.state.doc, p = center(child.id), at = screen(p.x, p.y)
  await act(async () => { pointer('pointerdown', at[0], at[1]); pointer('pointerup', at[0], at[1]) })
  expect(editor.state.selection).toEqual([child.id]); unchanged(before)
  const to = screen(p.x + 20, p.y + 30)
  await act(async () => pointer('pointerdown', at[0], at[1]))
  await act(async () => pointer('pointerup', to[0], to[1]))
  delta(before, child.id, 20, 30)
  for (const n of [outer, inner, backing]) expect(editor.state.doc.nodes[n.id]).toEqual(before.nodes[n.id])
  await oneHistory(before)
})
test('S02 Enter/ShiftEnter ordered multi-root hierarchy, IME/input guards and redo preservation', async () => {
  const a = node('frame', 100, 100, 100, 100), b = node('frame', 300, 100, 100, 100)
  const children = [0, 1, 2, 3].map(i => node('rectangle', 10 + (i % 2) * 40, 10, 20, 20))
  a.children = children.slice(0, 2).map(n => n.id); b.children = children.slice(2).map(n => n.id)
  await render([a, b, ...children], [a.id, b.id]); const before = await redoSeed(a.id)
  await act(async () => { editor.select([a.id, b.id]); key('Enter') })
  expect(editor.state.selection).toEqual([children[1].id, children[0].id, children[3].id, children[2].id])
  await act(async () => key('Enter', { shiftKey: true })); expect(editor.state.selection).toEqual([a.id, b.id])
  await act(async () => key('Enter', { isComposing: true })); expect(editor.state.selection).toEqual([a.id, b.id])
  const input = document.createElement('input'); host().append(input); await act(async () => input.focus())
  await act(async () => key('Enter', {}, 'keydown', input)); expect(editor.state.selection).toEqual([a.id, b.id]); await act(async () => input.remove())
  await act(async () => { editor.select([a.id]); host().focus(); key('Enter') }); expect(editor.state.selection).toEqual([children[1].id, children[0].id])
  await act(async () => key('Enter', { shiftKey: true })); expect(editor.state.selection).toEqual([a.id])
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[a.id].name).toBe('Redo survives navigation')
})
for (const reverse of [false, true]) test(`S03 Figma marquee ${reverse ? 'reverse' : 'forward'} excludes hidden/locked ancestors and Shift adds`, async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 160, 100, 30, 30), retained = node('rectangle', 500, 400, 30, 30)
  const locked = node('frame', 200, 100, 30, 30), hidden = node('frame', 200, 140, 30, 30), lc = node('rectangle', 0, 0, 20, 20), hc = node('rectangle', 0, 0, 20, 20)
  locked.locked = true; hidden.visible = false; locked.children = [lc.id]; hidden.children = [hc.id]
  await render([a, b, retained, locked, hidden, lc, hc], [a.id, b.id, retained.id, locked.id, hidden.id]); const before = editor.state.doc
  await act(async () => editor.select([retained.id]))
  await marquee(reverse ? [240, 180] : [80, 80], reverse ? [80, 80] : [240, 180], { shiftKey: true })
  expect(ordered(editor.state.selection)).toEqual(ordered([a.id, b.id, retained.id])); unchanged(before)
})
for (const end of ['Escape', 'pointercancel'] as const) test(`S03 marquee ${end} restores initial selection and redo`, async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 500, 400, 30, 30)
  await render([a, b]); const before = await redoSeed(b.id); await act(async () => editor.select([b.id]))
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  await act(async () => end === 'Escape' ? key('Escape') : pointer('pointercancel', 180, 180))
  expect(editor.state.selection).toEqual([b.id]); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
})
test('S04 actual menu and registered keyboard select-all/inverse have identical eligible root sets and focus guard', async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 200, 100, 30, 30), l = node('rectangle', 300, 100, 30, 30), h = node('rectangle', 400, 100, 30, 30)
  l.locked = true; h.visible = false; await render([a, b, l, h]); const before = editor.state.doc
  await act(async () => editor.select([a.id])); await menuAction('反选'); const inverse = [...editor.state.selection]; expect(inverse).toEqual([b.id])
  await act(async () => { editor.select([a.id]); host().focus(); key('a', { metaKey: true, shiftKey: true }) }); expect(editor.state.selection).toEqual(inverse)
  await act(async () => editor.select([])); await menuAction('全选'); const all = [...editor.state.selection]; expect(ordered(all)).toEqual(ordered([a.id, b.id]))
  await act(async () => { editor.select([a.id]); host().focus(); key('a', { metaKey: true }) }); expect(editor.state.selection).toEqual(all)
  const input = document.createElement('input'); host().append(input); await act(async () => input.focus())
  await act(async () => { editor.select([a.id]); key('a', { metaKey: true }, 'keydown', input); key('a', { metaKey: true, shiftKey: true }, 'keydown', input) })
  expect(editor.state.selection).toEqual([a.id]); unchanged(before); await act(async () => input.remove())
})
async function rotatedFixture(zoom: number) {
  const p = node('frame', 100, 100, 350, 300), q = node('frame', 500, 100, 350, 300), a = node('rectangle', 60, 70, 40, 30), b = node('rectangle', 60, 70, 40, 30), untouched = node('rectangle', 20, 210, 30, 30)
  a.fills = [{ ...paint('#ffffff'), kind: 'image', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG/QAAAAASUVORK5CYII=' }]
  a.name = '作者图层 α'; rotate(p, 30); rotate(q, -20); p.children = [a.id, untouched.id]; q.children = [b.id]
  await render([p, q, a, b, untouched], [p.id, q.id]); await act(async () => { editor.select([a.id, b.id]); editor.set({ view: { x: 15, y: 25, zoom } }) })
  return { p, q, a, b, untouched }
}
for (const zoom of [.5, 2]) test(`M01 cross-rotated-parent multi-selection world delta100,50 zoom${zoom}, one history`, async () => {
  const { p, q, a, b, untouched } = await rotatedFixture(zoom), before = editor.state.doc
  await drag(a.id, 100, 50); delta(before, a.id, 100, 50); delta(before, b.id, 100, 50)
  for (const n of [p, q, untouched]) expect(editor.state.doc.nodes[n.id]).toEqual(before.nodes[n.id])
  expect(editor.state.selection).toEqual([a.id, b.id]); await oneHistory(before)
})
for (const end of ['pointerup', 'Escape', 'pointercancel'] as const) test(`M02 parent+child deduplicated drag ${end} preserves exact history`, async () => {
  const p = node('group', 100, 100, 120, 50), a = node('rectangle', 0, 0, 50, 50), b = node('rectangle', 70, 0, 50, 50)
  p.children = [a.id, b.id]; await render([p, a, b], [p.id]); const before = await redoSeed(p.id)
  await act(async () => editor.select([p.id, a.id])); await drag(a.id, 40, 30, end)
  if (end === 'pointerup') { delta(before, p.id, 40, 30); delta(before, a.id, 40, 30); delta(before, b.id, 40, 30); expect(editor.state.doc.nodes[a.id].transform).toEqual(before.nodes[a.id].transform); await oneHistory(before) }
  else { expect(editor.state.doc).toEqual(before); expect(editor.state.selection).toEqual([p.id, a.id]); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true); await act(async () => editor.redo()); expect(editor.state.doc.nodes[p.id].name).toBe('Redo survives navigation') }
})
test('M03 registered small/big direction keys author correct world displacement and independent undo', async () => {
  const a = node('rectangle', 100, 100, 40, 30); await render([a]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  await act(async () => { key('ArrowRight'); key('ArrowRight', {}, 'keyup') }); delta(before, a.id, 1, 0)
  await act(async () => { key('ArrowDown', { shiftKey: true }); key('ArrowDown', { shiftKey: true }, 'keyup') }); delta(before, a.id, 1, 10)
  await act(async () => editor.undo()); delta(before, a.id, 1, 0)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
})
async function inputValue(label: string, value: string, finish: 'Enter' | 'Escape') {
  const input = mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; expect(input).not.toBeNull()
  await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => key(finish, {}, 'keydown', input)); await act(async () => input.blur())
}
for (const label of ['X', 'Y']) test(`M03 mounted ${label} valid Enter+blur single commit, invalid and Escape cancel preserve redo`, async () => {
  const a = node('rectangle', 100, 100, 40, 30); await render([a]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  await inputValue(label, '250', 'Enter'); delta(before, a.id, label === 'X' ? 150 : 0, label === 'Y' ? 150 : 0)
  const after = editor.state.doc; await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  await inputValue(label, 'not-a-number', 'Enter'); expect(editor.state.doc).toEqual(before); expect(editor.canRedo).toBe(true)
  await inputValue(label, '999', 'Escape'); expect(editor.state.doc).toEqual(before); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
})
test('M04 real moved graph native binary save/decode/new Editor preserves IDs/hierarchy/resources/world matrices', async () => {
  const { a, b } = await rotatedFixture(.5); await drag(a.id, 100, 50)
  const saved = editor.state.doc; expect(saved.nodes[a.id].fills[0].image).toMatch(/^data:image\/png;base64,/); expect(saved.nodes[a.id].name).toBe('作者图层 α')
  const bytes = encodeDocumentBinary(saved); expect(bytes.length).toBeGreaterThan(32)
  const decoded = decodeDocumentBinary(bytes); expect(decoded).toEqual(saved)
  const reopened = new Editor(decoded as typeof saved)
  try {
    expect(reopened.state.doc).toEqual(saved)
    for (const id of Object.keys(saved.nodes)) expect(worldMatrix(reopened.state.doc, id)).toEqual(worldMatrix(saved, id))
    expect(reopened.state.doc.pages).toEqual(saved.pages); expect(reopened.state.doc.nodes[a.id]).toEqual(saved.nodes[a.id]); expect(reopened.state.doc.nodes[b.id]).toEqual(saved.nodes[b.id])
    expect(reopened.canUndo).toBe(false); expect(reopened.canRedo).toBe(false)
  } finally { reopened.dispose() }
})

test('S03 lostpointercapture restores marquee origin selection without consuming redo', async () => {
  const a = node('rectangle', 100, 100, 30, 30), b = node('rectangle', 500, 400, 30, 30)
  await render([a, b]); const before = await redoSeed(b.id); await act(async () => editor.select([b.id]))
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  await act(async () => pointer('lostpointercapture', 180, 180))
  expect(editor.state.selection).toEqual([b.id]); expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[b.id].name).toBe('Redo survives navigation')
})
for (const boundary of ['session', 'page'] as const) for (const end of ['Escape', 'pointercancel', 'lostpointercapture'] as const)
  test(`S03 stale marquee ${end} after ${boundary} change never restores old selection`, async () => {
    const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30), next = node('rectangle', 600, 300, 40, 40)
    await render([a, old, next], [a.id, old.id], [next.id]); await act(async () => editor.select([old.id]))
    await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
    let accepted = editor.state.doc
    // Dispatch synchronously before React layout effects clear the old drag ref.
    await act(async () => {
      if (boundary === 'session') {
        const doc = blank('Replacement session'); doc.nodes[next.id] = next; doc.pages[0].children = [next.id]; editor.load(doc)
      } else editor.switchPage(editor.state.doc.pages[1].id)
      editor.select([next.id]); accepted = editor.state.doc
      if (end === 'Escape') key('Escape'); else pointer(end, 180, 180)
    })
    expect(editor.state.doc).toBe(accepted); expect(editor.state.selection).toEqual([next.id])
    expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
  })
for (const zoom of [.5, 2]) test(`M01 independent Space preserveParent control at zoom${zoom}`, async () => {
  const { p, q, a, b, untouched } = await rotatedFixture(zoom), before = editor.state.doc
  const at = center(a.id), from = screen(at.x, at.y), to = screen(at.x + 100, at.y + 50)
  await act(async () => pointer('pointerdown', from[0], from[1]))
  await act(async () => key(' ', { code: 'Space' }))
  await act(async () => pointer('pointermove', to[0], to[1]))
  await act(async () => pointer('pointerup', to[0], to[1]))
  await act(async () => key(' ', { code: 'Space' }, 'keyup'))
  delta(before, a.id, 100, 50); delta(before, b.id, 100, 50)
  for (const n of [p, q, untouched]) expect(editor.state.doc.nodes[n.id]).toEqual(before.nodes[n.id])
  expect(editor.state.selection).toEqual([a.id, b.id]); await oneHistory(before)
})
test('M01 independent intentional single-child cross-frame drop reparents once and preserves world delta/undo', async () => {
  const p = node('frame', 100, 100, 200, 200), q = node('frame', 450, 100, 200, 200), a = node('rectangle', 50, 50, 40, 40)
  p.children = [a.id]; await render([p, q, a], [p.id, q.id]); await act(async () => editor.select([a.id])); const before = editor.state.doc
  await drag(a.id, 350, 0); delta(before, a.id, 350, 0)
  expect(editor.state.doc.nodes[p.id].children).toEqual([]); expect(editor.state.doc.nodes[q.id].children).toEqual([a.id])
  expect(editor.state.doc.nodes[p.id].transform).toEqual(before.nodes[p.id].transform); expect(editor.state.doc.nodes[q.id].transform).toEqual(before.nodes[q.id].transform)
  expect(editor.state.doc.nodes[a.id].fills).toEqual(before.nodes[a.id].fills); expect(editor.state.selection).toEqual([a.id]); await oneHistory(before)
})

test('S03 cancellation restores ordered Layers-origin locked/hidden selection without authoring history', async () => {
  const a = node('rectangle', 100, 100, 30, 30), locked = node('rectangle', 500, 400, 30, 30), hidden = node('rectangle', 600, 400, 30, 30)
  locked.locked = true; hidden.visible = false
  await render([a, locked, hidden]); const before = editor.state.doc
  await act(async () => editor.select([hidden.id, locked.id]))
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180)); await act(async () => pointer('pointercancel', 180, 180))
  expect(editor.state.selection).toEqual([hidden.id, locked.id]); unchanged(before)
})
test('S03 cancellation filters deleted and transferred origins but preserves surviving order and authored edit', async () => {
  const a = node('rectangle', 100, 100, 30, 30), gone = node('rectangle', 500, 400, 30, 30), moved = node('rectangle', 600, 400, 30, 30), retained = node('rectangle', 700, 400, 30, 30), other = node('rectangle', 0, 0, 30, 30)
  await render([a, gone, moved, retained, other], [a.id, gone.id, moved.id, retained.id], [other.id])
  await act(async () => editor.select([gone.id, retained.id, moved.id]))
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  await act(async () => editor.change('Concurrent origin removal', doc => {
    delete doc.nodes[gone.id]; doc.pages[0].children = doc.pages[0].children.filter(id => id !== gone.id && id !== moved.id); doc.pages[1].children.push(moved.id)
  }))
  const authored = editor.state.doc
  await act(async () => pointer('lostpointercapture', 180, 180))
  expect(editor.state.selection).toEqual([retained.id]); expect(editor.state.doc).toBe(authored); expect(editor.state.doc.nodes[gone.id]).toBeUndefined()
  expect(editor.state.doc.pages[1].children).toContain(moved.id); expect(editor.canUndo).toBe(true)
})
for (const end of ['pointercancel', 'lostpointercapture']) test(`S03 foreign ${end} cannot cancel the owning marquee`, async () => {
  const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30)
  await render([a, old]); await act(async () => editor.select([old.id])); const before = editor.state.doc
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  const transient = [...editor.state.selection]
  await act(async () => pointer(end, 180, 180, {}, host(), 99)); expect(editor.state.selection).toEqual(transient)
  await act(async () => pointer('pointerup', 180, 180)); expect(editor.state.selection).toEqual([a.id]); unchanged(before)
})
test('S03 replacement session with same document ID cannot receive prior marquee origins', async () => {
  const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30), next = node('rectangle', 600, 400, 30, 30)
  await render([a, old, next]); await act(async () => editor.select([old.id]))
  const source = editor.state.doc, generation = editor.sessionGeneration
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  await act(async () => { editor.load(structuredClone(source)); editor.select([next.id]); pointer('pointercancel', 180, 180) })
  expect(editor.state.doc.id).toBe(source.id); expect(editor.sessionGeneration).not.toBe(generation); expect(editor.state.selection).toEqual([next.id]); expect(editor.canUndo).toBe(false)
})
test('S03 successful marquee followed by repeated lostcapture cannot roll back committed selection', async () => {
  const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30)
  await render([a, old]); await act(async () => editor.select([old.id])); const before = editor.state.doc
  await marquee([80, 80], [180, 180]); expect(editor.state.selection).toEqual([a.id])
  await act(async () => { pointer('lostpointercapture', 180, 180); pointer('lostpointercapture', 180, 180) })
  expect(editor.state.selection).toEqual([a.id]); unchanged(before)
})

for (const end of ['Escape', 'pointercancel', 'lostpointercapture'] as const)
  test(`S03 synchronous restoration subscriber loads same-ID session during ${end}: new tool/selection survive`, async () => {
    const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30), next = node('rectangle', 600, 400, 30, 30)
    await render([a, old, next]); await act(async () => editor.select([old.id]))
    const source = editor.state.doc, generation = editor.sessionGeneration
    await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
    let observed = 0, replacement = source
    const unsubscribe = editor.subscribe(() => {
      if (editor.state.selection.length !== 1 || editor.state.selection[0] !== old.id) return
      unsubscribe(); observed++
      editor.load(structuredClone(source)); editor.select([next.id]); editor.set({ tool: 'rectangle' }); replacement = editor.state.doc
    })
    try {
      await act(async () => end === 'Escape' ? key('Escape') : pointer(end, 180, 180))
      expect(observed).toBe(1); expect(editor.sessionGeneration).not.toBe(generation)
      expect(editor.state.doc).toBe(replacement); expect(editor.state.doc.id).toBe(source.id)
      expect(editor.state.selection).toEqual([next.id]); expect(editor.state.tool).toBe('rectangle')
      expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(false)
    } finally { unsubscribe() }
  })

for (const end of ['Escape', 'pointercancel', 'lostpointercapture'] as const)
  test(`S03 restoration subscriber starts a new pointer gesture during ${end}: old cleanup cannot erase it`, async () => {
    const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30)
    await render([a, old]); await act(async () => editor.select([old.id])); const before = editor.state.doc
    await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
    let observed = 0
    const unsubscribe = editor.subscribe(() => {
      if (editor.state.selection.length !== 1 || editor.state.selection[0] !== old.id) return
      unsubscribe(); observed++; pointer('pointerdown', 115, 115, {}, host(), 8)
    })
    try {
      await act(async () => end === 'Escape' ? key('Escape') : pointer(end, 180, 180))
      expect(observed).toBe(1)
      await act(async () => pointer('pointerup', 135, 145, {}, host(), 8))
      expect(editor.state.selection).toEqual([a.id]); delta(before, a.id, 20, 30)
      expect(editor.state.doc.nodes[old.id]).toEqual(before.nodes[old.id]); await oneHistory(before)
    } finally { unsubscribe() }
  })
test('S03 restoration subscriber repeats pointercancel: detached owner restores only once and preserves redo', async () => {
  const a = node('rectangle', 100, 100, 30, 30), old = node('rectangle', 500, 400, 30, 30)
  await render([a, old]); const before = await redoSeed(old.id); await act(async () => editor.select([old.id]))
  await act(async () => pointer('pointerdown', 80, 80)); await act(async () => pointer('pointermove', 180, 180))
  let restorations = 0
  const unsubscribe = editor.subscribe(() => {
    if (editor.state.selection.length !== 1 || editor.state.selection[0] !== old.id) return
    restorations++
    if (restorations === 1) pointer('pointercancel', 180, 180)
  })
  try {
    await act(async () => pointer('pointercancel', 180, 180))
    expect(restorations).toBe(1); expect(editor.state.selection).toEqual([old.id]); expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true)
  } finally { unsubscribe() }
})
