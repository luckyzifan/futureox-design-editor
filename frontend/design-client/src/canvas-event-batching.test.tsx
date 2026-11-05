import { bindNavigationInput } from './kernel/navigation-input'
// Actual mounted Canvas/event propagation + Editor/WASM. The render-device
// boundary alone is replaced. Deterministic 60 Hz delivery does not claim
// browser/GPU FPS, compositor latency, or pixel quality.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { PageList } from './PageList'
import { Layers } from './Layers'
import { Editor } from './engine'
import { blank, node, uid, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { apply, inverse, worldMatrix } from './geometry'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { paint, stroke } from './model'
import { PencilInput } from './freehand'
import * as handles from './selection-handles'

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
const baseline = process.env.CANVAS_EVENT_BASELINE === '1'
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
async function render(nodes: DesignNode[], roots = nodes.map(n => n.id), otherRoots: string[] = [], withPages = false) {
  const doc = blank('Canvas event batching'); doc.nodes = Object.fromEntries(nodes.map(n => [n.id, n])); doc.pages[0].children = roots
  doc.id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; doc.pages[0].id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  doc.pages.push({ ...doc.pages[0], id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Empty page', children: [] })
  if (otherRoots.length) doc.pages.push({ ...doc.pages[0], id: uid(), name: 'Other page', children: otherRoots })
  editor.load(doc); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  await act(async () => { root.render(<><Canvas editor={editor} />{withPages && <PageList editor={editor} onRename={() => {}} />}</>); for (let i = 0; i < 6; i++) await Promise.resolve() })
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

async function flushFrames(at = 0) {
  await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(at) } })
}
function vector() {
  const n = node('vector', 100, 100, 180, 120); n.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  n.network = { fillRule: 'nonzero', vertices: [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 180, y: 0 }, { id: 'c', x: 180, y: 120 }, { id: 'd', x: 0, y: 120 },
  ], edges: [
    { id: 'ab', from: 'a', to: 'b', c1: { x: 60, y: 30 }, c2: { x: 120, y: 30 } },
    { id: 'bc', from: 'b', to: 'c' }, { id: 'cd', from: 'c', to: 'd' }, { id: 'da', from: 'd', to: 'a' },
  ] }
  n.strokes = [{ ...stroke('#123456', 12), widthProfile: [
    { position: 0, left: 1, right: 1 }, { position: .5, left: 1, right: 1 }, { position: 1, left: 1, right: 1 },
  ] }]
  n.strokes[0].id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  n.strokes[0].paint.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  return n
}
type EditKind = 'vertex' | 'handle' | 'width'
async function begin(kind: EditKind, withPages = false) {
  const n = vector(), before = await render([n], [n.id], [], withPages)
  await act(async () => { editor.select([n.id]); editor.set({ tool: kind === 'width' ? 'width' : 'vector' }) })
  const target = kind === 'vertex' ? mount.querySelector('[data-testid="vector-anchor"]')! :
    kind === 'width' ? mount.querySelector('[data-testid^="width-"]')! :
    [...mount.querySelectorAll('circle')].find(e => e.getAttribute('r') === '3.5')!
  expect(target).toBeDefined()
  const start = kind === 'vertex' ? { x: 100, y: 100 } :
    { x: 100 + Number(target.getAttribute('cx')), y: 100 + Number(target.getAttribute('cy')) }
  // Width handles already have world coordinates, unlike local path controls.
  if (kind === 'width') { start.x -= 100; start.y -= 100 }
  await act(async () => pointer('pointerdown', start.x, start.y, {}, target))
  expect(editor.interactionActive).toBe(true)
  return { n, before, start }
}
async function verifyHistory(before: typeof editor.state.doc) {
  const after = editor.state.doc
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
  await act(async () => editor.redo()); expect(editor.state.doc).toEqual(after)
  await flushFrames(); expect(editor.state.doc).toBe(after)
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function report(data: Record<string, unknown>) {
  const row = { runtime: 'mounted React/jsdom Canvas + real Editor/WASM; renderer boundary stub', baseline, ...data }
  console.info('CANVAS_EVENT_METRIC', JSON.stringify(row))
  if (process.env.CANVAS_EVENT_METRICS) appendFileSync(process.env.CANVAS_EVENT_METRICS, JSON.stringify(row) + '\n')
}

test.each(['vertex', 'handle', 'width'] as const)('%s consumes only latest owner input and the exact release, with one undo step', async kind => {
  const { n, before, start } = await begin(kind), preview = vi.spyOn(editor, 'preview')
  for (let i = 1; i <= 20; i++) await act(async () => pointer('pointermove', start.x + i / 4, start.y + i / 3))
  expect(preview).toHaveBeenCalledTimes(baseline ? 20 : 0)
  await act(async () => pointer('pointermove', 900, 700, {}, host(), 99))
  await flushFrames(); expect(preview).toHaveBeenCalledTimes(baseline ? 20 : 1)
  await act(async () => pointer('pointermove', start.x + 10.125, start.y + 8.875))
  await act(async () => pointer('pointerup', start.x + 13.25, start.y + 9.75))
  expect(editor.interactionActive).toBe(false)
  const result = editor.state.doc.nodes[n.id]
  if (kind === 'vertex') expect(result.network!.vertices[0]).toEqual({ id: 'a', x: 13.25, y: 9.75 })
  if (kind === 'handle') expect(result.network!.edges[0].c1).toEqual({ x: 73.25, y: 39.75 })
  expect(result).not.toEqual(before.nodes[n.id])
  await verifyHistory(before)
})

test.each([120, 240, 1000])('deterministic %i Hz vertex trace has identical final geometry/history with bounded 60 Hz previews', async hz => {
  const { n, before, start } = await begin('vertex'), preview = vi.spyOn(editor, 'preview')
  let notifications = 0; const unsubscribe = editor.subscribe(() => { notifications++ })
  const duration = 250, count = hz * duration / 1000
  const started = performance.now(); let nextFrame = 1000 / 60, frameCount = 0
  for (let i = 1; i <= count; i++) {
    const at = i * 1000 / hz
    await act(async () => pointer('pointermove', start.x + i * .125, start.y + Math.sin(i / 8) * 5))
    if (at >= nextFrame) { await flushFrames(at); nextFrame += 1000 / 60; frameCount++ }
  }
  await act(async () => pointer('pointerup', start.x + 43.125, start.y - 7.875))
  const cpuMs = performance.now() - started, previews = preview.mock.calls.length; unsubscribe()
  expect(editor.state.doc.nodes[n.id].network!.vertices[0]).toEqual({ id: 'a', x: 43.125, y: -7.875 })
  expect(previews).toBe(baseline ? count + 1 : frameCount + 1)
  const finalNodeHash = digest(editor.state.doc.nodes[n.id]), finalDocumentHash = digest(editor.state.doc)
  await verifyHistory(before)
  report({ kind: 'vertex', hz, duration, samples: count, frameCount, previews, notifications, cpuMs, finalNodeHash, finalDocumentHash })
}, 120000)

test.each(['pointercancel', 'lostpointercapture', 'escape', 'blur'] as const)('queued vertex work cannot survive %s or enter a restarted drag', async ending => {
  const { before, start } = await begin('vertex')
  await act(async () => pointer('pointermove', start.x + 4, start.y + 3)); await flushFrames()
  await act(async () => pointer('pointermove', start.x + 60, start.y + 30))
  await act(async () => {
    if (ending === 'escape') key('Escape')
    else if (ending === 'blur') window.dispatchEvent(new Event('blur'))
    else pointer(ending, start.x + 60, start.y + 30)
  })
  expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
  await flushFrames(); expect(editor.state.doc).toEqual(before)
  await act(async () => editor.set({ tool: 'vector' }))
  const target = mount.querySelector('[data-testid="vector-anchor"]')!
  await act(async () => pointer('pointerdown', start.x, start.y, {}, target))
  await act(async () => pointer('pointerup', start.x + .125, start.y + .25))
  expect(editor.state.doc.nodes['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].network!.vertices[0]).toEqual({ id: 'a', x: .125, y: .25 })
})

test('a queued first vertex input uses current Control modifiers and cannot replay stale snapping afterward', async () => {
  const { start } = await begin('vertex')
  await act(async () => editor.set({ snapPixels: true }))
  await act(async () => pointer('pointermove', start.x + 8.125, start.y + 6.25))
  await act(async () => key('Control', { ctrlKey: true }))
  if (!baseline) expect(editor.state.doc.nodes['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].network!.vertices[0]).toEqual({ id: 'a', x: 8.125, y: 6.25 })
  await flushFrames()
  await act(async () => pointer('pointerup', start.x + 8.125, start.y + 6.25, { ctrlKey: true }))
  expect(editor.state.doc.nodes['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].network!.vertices[0]).toEqual({ id: 'a', x: 8.125, y: 6.25 })
})

test('returning an existing vertex to its start preserves its original geometry exactly', async () => {
  const { before, start } = await begin('vertex')
  await act(async () => pointer('pointermove', start.x + 22, start.y - 5)); await flushFrames()
  await act(async () => pointer('pointermove', start.x + 1, start.y + 1))
  await act(async () => pointer('pointerup', start.x, start.y))
  expect(editor.state.doc).toEqual(before)
})

test('freehand processes every coalesced point immediately, including non-primary-owner rejection', async () => {
  await render([]); await act(async () => editor.set({ tool: 'pencil' }))
  const append = vi.spyOn(PencilInput.prototype, 'append')
  await act(async () => pointer('pointerdown', 10, 10))
  for (let i = 1; i <= 20; i++) await act(async () => {
    const event = new MouseEvent('pointermove', { bubbles: true, clientX: 10 + i, clientY: 10 + i / 2 })
    const samples = [0, .25, .5].map(offset => ({ clientX: 10 + i + offset, clientY: 10 + i / 2, pointerId: 7, pointerType: 'pen', pressure: .4 }))
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, getCoalescedEvents: { value: () => samples } })
    host().dispatchEvent(event)
  })
  expect(append).toHaveBeenCalledTimes(21)
  expect(append.mock.calls.slice(1).reduce((sum, call) => sum + call[0].length, 0)).toBe(60)
  await act(async () => pointer('pointermove', 900, 900, {}, host(), 99)); expect(append).toHaveBeenCalledTimes(21)
  await act(async () => pointer('pointerup', 32, 22)); expect(append).toHaveBeenCalledTimes(22)
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
})

test('selection handle geometry is reused for unrelated editor notifications', async () => {
  const n = vector(); await render([n]); await act(async () => editor.select([n.id]))
  const computation = vi.spyOn(handles, 'selectionHandles')
  await act(async () => editor.notify('First notice'))
  await act(async () => editor.notify('Second notice'))
  if (!baseline) expect(computation).toHaveBeenCalledTimes(0)
  else expect(computation.mock.calls.length).toBeGreaterThan(0)
})

test.each(['marquee', 'zoom', 'crop'] as const)('%s overlay batches latest input and commits exact release geometry', async kind => {
  const n = node('rectangle', 100, 100, 160, 120)
  if (kind === 'crop') n.fills = [{ ...paint('#ffffff', 'image'), fit: 'stretch',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }]
  const before = await render([n])
  if (kind === 'crop') await act(async () => editor.select([n.id]))
  await act(async () => editor.set({ tool: kind === 'marquee' ? 'select' : kind }))
  const start = kind === 'crop' ? [110, 110] : [50, 50]
  await act(async () => pointer('pointerdown', start[0], start[1]))
  for (let i = 1; i <= 20; i++) await act(async () => pointer('pointermove', start[0] + i, start[1] + i))
  const overlay = () => kind === 'crop' ? mount.querySelector('[data-testid="crop-overlay"] rect') :
    mount.querySelector('svg.stage rect[stroke="#4597f7"][pointer-events="none"]')
  if (kind === 'crop' && !baseline) expect(overlay()).toBeNull()
  if (kind !== 'crop') expect(Number(overlay()!.getAttribute('width'))).toBe(baseline ? 20 : 0)
  await flushFrames()
  const shown = overlay(); expect(shown).not.toBeNull()
  expect(Number(shown!.getAttribute('width'))).toBe(20)
  await act(async () => pointer('pointermove', 130, 130))
  await act(async () => pointer('pointerup', 240, 200))
  expect(overlay()).toBeNull()
  if (kind === 'marquee') { expect(editor.state.selection).toEqual([n.id]); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false) }
  else if (kind === 'zoom') { expect(editor.state.view.zoom).toBeCloseTo(Math.min(1000 / 190, 800 / 150), 12); expect(editor.state.doc).toBe(before) }
  else {
    expect(editor.state.doc.nodes[n.id].transform).toEqual([1, 0, 0, 1, 110, 110])
    expect(editor.state.doc.nodes[n.id].width).toBe(130); expect(editor.state.doc.nodes[n.id].height).toBe(90)
    await verifyHistory(before)
  }
})

test.each(['page', 'document', 'unmount'] as const)('queued input does not mutate an ended %s scope', async ending => {
  const { start } = await begin('vertex')
  await act(async () => pointer('pointermove', start.x + 90, start.y + 70))
  await act(async () => {
    if (ending === 'unmount') root.render(null)
    else if (ending === 'document') editor.load(blank('Replacement document'))
    else editor.set({ page: 'ffffffff-ffff-4fff-8fff-ffffffffffff', selection: [] })
  })
  const stopped = editor.state.doc
  await flushFrames(); expect(editor.state.doc).toBe(stopped)
})

// Explicit opt-in reproducer for an independently found pre-existing failure.
// Direct Editor.addPage while an edit transaction remains active is stronger
// than ordinary page-switch input; automation rejects active interactions.
test.skipIf(process.env.CANVAS_REPRO_ADD_PAGE !== '1')('reproduce direct addPage during a live vertex transaction', async () => {
  const { start } = await begin('vertex')
  await act(async () => pointer('pointermove', start.x + 90, start.y + 70))
  const draft = editor.state.doc, page = editor.state.page, version = editor.state.version
  await act(async () => { expect(editor.addPage()).toBe(false); expect(editor.state.doc).toBe(draft) })
  // A queued pointer preview may legitimately publish during the frame flush.
  await flushFrames()
  expect(editor.state.doc.pages.map(value => value.id)).toEqual(draft.pages.map(value => value.id))
  expect(editor.state.page).toBe(page)
  expect(editor.state.version).toBe(version)
  expect(editor.interactionActive).toBe(true)
  await act(async () => pointer('pointerup', start.x + 90, start.y + 70))
  expect(editor.interactionActive).toBe(false)
  await act(async () => { expect(editor.addPage()).toBe(true) })
  await flushFrames()
  const newPage = editor.state.page
  expect(newPage).not.toBe(page)
  expect(editor.state.doc.pages.some(value => value.id === newPage)).toBe(true)
  await act(async () => editor.undo())
  expect(editor.state.page).toBe(page)
  await act(async () => editor.redo())
  expect(editor.state.page).toBe(newPage)
})

test('pen construction remains sample-preserving even when the pointer returns within its drag threshold', async () => {
  await render([]); await act(async () => editor.set({ tool: 'pen' }))
  await act(async () => pointer('pointerdown', 100, 100))
  await act(async () => pointer('pointermove', 120, 115))
  await act(async () => pointer('pointermove', 100.25, 100.25))
  await act(async () => pointer('pointerup', 100.25, 100.25))
  await act(async () => pointer('pointerdown', 200, 100))
  await act(async () => pointer('pointerup', 200, 100))
  await act(async () => key('Enter'))
  const n = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
  expect(n.network!.edges[0].c1).toEqual({ x: 20, y: 15 })
})

test.each(['vertex', 'handle', 'width'] as const)('%s click without movement remains an exact no-op', async kind => {
  const { before, start } = await begin(kind)
  await act(async () => pointer('pointerup', start.x, start.y))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('width Shift transitions consume the newest queued sample and preserve symmetric release precision', async () => {
  const { before, start } = await begin('width')
  await act(async () => pointer('pointermove', start.x + 2.125, start.y + 3.25))
  await act(async () => key('Shift', { shiftKey: true }))
  await flushFrames()
  if (!baseline) {
    const points = editor.state.doc.nodes['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].strokes[0].widthProfile!
    expect(points[0].left).toBe(points[0].right)
  }
  await act(async () => pointer('pointerup', start.x + 5.125, start.y + 7.25, { shiftKey: true }))
  const points = editor.state.doc.nodes['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].strokes[0].widthProfile!
  expect(points[0].left).toBe(points[0].right); expect(points[0]).toEqual({ ...points.at(-1), position: 0 })
  await verifyHistory(before)
})

test('nested reflected/skewed vertex drag preserves fractional geometry and its full document', async () => {
  const n = vector(), parent = node('group', 500, 200, 500, 500)
  parent.id = '11111111-1111-4111-8111-111111111111'
  parent.transform = [-1.2, .2, .15, 1.3, 500, 200]; parent.children = [n.id]
  n.transform = [1.25, .25, -.4, .9, 100, 100]
  const before = await render([parent, n], [parent.id])
  await act(async () => { editor.select([n.id]); editor.set({ tool: 'vector' }) })
  const matrix = worldMatrix(before, n.id), from = apply(matrix, { x: 0, y: 0 })
  const target = mount.querySelector('[data-testid="vector-anchor"]')!
  await act(async () => pointer('pointerdown', from.x, from.y, {}, target))
  for (let i = 1; i <= 24; i++) await act(async () => pointer('pointermove', from.x + i / 4, from.y - i / 8))
  await flushFrames()
  const to = { x: from.x + 7.125, y: from.y - 9.25 }
  await act(async () => pointer('pointerup', to.x, to.y))
  const local = apply(inverse(matrix), to), start = apply(inverse(matrix), from)
  expect(editor.state.doc.nodes[n.id].network!.vertices[0]).toEqual({ id: 'a', x: local.x - start.x, y: local.y - start.y })
  const finalDocumentHash = digest(editor.state.doc)
  await verifyHistory(before); report({ kind: 'nested-vertex', finalDocumentHash })
})

const click = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
test('page creation and menu topology edits are blocked during a live Canvas gesture, then recover after release', async () => {
  const { before, start } = await begin('vertex', true)
  await act(async () => pointer('pointermove', start.x + 10.125, start.y + 5.25)); await flushFrames()
  const pending = editor.state.doc
  await act(async () => click(mount.querySelector('[title="添加页面"]')!))
  expect(editor.state.doc).toBe(pending); expect(editor.interactionActive).toBe(true)
  for (const label of ['复制页面', '页面下移']) {
    await act(async () => click(mount.querySelector('.page-options')!))
    const button = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent === label)!
    await act(async () => click(button)); expect(editor.state.doc).toBe(pending)
  }
  await act(async () => pointer('pointerup', start.x + 11.125, start.y + 6.25))
  await verifyHistory(before)
  await act(async () => click(mount.querySelector('[title="添加页面"]')!))
  expect(editor.state.doc.pages).toHaveLength(before.pages.length + 1)
})

test('page mutation handlers recheck busy state and a gesture that starts after row dragstart', async () => {
  const n = vector(), before = await render([n], [n.id], [], true)
  await act(async () => { editor.select([n.id]); editor.set({ tool: 'vector' }) })
  const rows = [...mount.querySelectorAll('.page-row')]
  const transfer = { setData() {}, effectAllowed: '', dropEffect: '' }
  const dragEvent = (type: string, target: Element) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 700 })
    Object.defineProperty(event, 'dataTransfer', { value: transfer }); target.dispatchEvent(event); return event
  }
  await act(async () => dragEvent('dragstart', rows[0]))
  await act(async () => pointer('pointerdown', 100, 100, {}, mount.querySelector('[data-testid="vector-anchor"]')!))
  expect(editor.interactionActive).toBe(true)
  await act(async () => dragEvent('drop', rows[1])); expect(editor.state.doc).toBe(before)
  await act(async () => pointer('pointercancel', 100, 100))
  await act(async () => editor.set({ busy: true }))
  await act(async () => click(mount.querySelector('[title="添加页面"]')!))
  expect(editor.state.doc).toBe(before)
  await act(async () => { expect(dragEvent('dragstart', rows[0]).defaultPrevented).toBe(true) })
  await act(async () => editor.set({ busy: false }))
  await act(async () => { expect(dragEvent('dragstart', rows[0]).defaultPrevented).toBe(false); dragEvent('drop', rows[1]) })
  expect(editor.state.doc.pages.map(p => p.id)).toEqual([...before.pages.map(p => p.id)].reverse())
})

test('actual page delete button checks gesture/busy state before and after confirmation', async () => {
  const n = vector(), before = await render([n])
  await act(async () => {
    editor.select([n.id]); editor.set({ tool: 'vector' })
    root.render(<><Canvas editor={editor} /><Layers editor={editor} section="layers" onSection={() => {}} /></>)
  })
  const confirm = vi.fn(() => true); vi.stubGlobal('confirm', confirm)
  const remove = () => click(mount.querySelector('[title="删除当前页面"]')!)
  const start = () => pointer('pointerdown', 100, 100, {}, mount.querySelector('[data-testid="vector-anchor"]')!)
  await act(async () => start())
  await act(async () => remove()); expect(confirm).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(before)
  await act(async () => pointer('pointercancel', 100, 100))
  await act(async () => editor.set({ busy: true }))
  await act(async () => remove()); expect(confirm).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(before)
  await act(async () => editor.set({ busy: false }))
  confirm.mockImplementationOnce(() => { start(); return true })
  await act(async () => remove()); expect(confirm).toHaveBeenCalledTimes(1)
  expect(editor.interactionActive).toBe(true); expect(editor.state.doc).toBe(before)
  await act(async () => pointer('pointercancel', 100, 100))
  confirm.mockImplementationOnce(() => { editor.set({ busy: true }); return true })
  await act(async () => remove()); expect(editor.state.doc).toBe(before)
  await act(async () => editor.set({ busy: false }))
  await act(async () => remove()); expect(editor.state.doc.pages).toHaveLength(before.pages.length - 1)
  await act(async () => editor.undo()); expect(editor.state.doc).toEqual(before)
})

test.each(['vertex', 'handle', 'width'] as const)('a pending hover must not discard the first %s drag frame', async kind => {
  const n = vector(); await render([n]); await act(async () => { editor.select([n.id]); editor.set({ tool: kind === 'width' ? 'width' : 'vector' }) })
  const target = kind === 'vertex' ? mount.querySelector('[data-testid="vector-anchor"]')! : kind === 'width' ? mount.querySelector('[data-testid^="width-"]')! : [...mount.querySelectorAll('circle')].find(e => e.getAttribute('r') === '3.5')!
  const start = kind === 'vertex' ? { x: 100, y: 100 } : { x: 100 + Number(target.getAttribute('cx')), y: 100 + Number(target.getAttribute('cy')) }
  if (kind === 'width') { start.x -= 100; start.y -= 100 }
  await act(async () => pointer('pointermove', start.x, start.y))
  await act(async () => pointer('pointerdown', start.x, start.y, {}, target))
  const preview = vi.spyOn(editor, 'preview')
  await act(async () => pointer('pointermove', start.x + 15.25, start.y + 12.75))
  await flushFrames()
  expect(preview).toHaveBeenCalledTimes(1)
  await act(async () => pointer('pointerup', start.x + 15.25, start.y + 12.75))
})

test('a foreign pointercancel cannot retire the owner queued frame', async () => {
  const { before, start } = await begin('vertex'), preview = vi.spyOn(editor, 'preview')
  await act(async () => pointer('pointermove', start.x + 1.5, start.y + 2.5))
  await act(async () => pointer('pointercancel', 700, 600, {}, host(), 99))
  await flushFrames(); expect(preview).toHaveBeenCalledTimes(1); expect(editor.interactionActive).toBe(true)
  await act(async () => pointer('pointerup', start.x + 3.5, start.y + 4.5))
  await verifyHistory(before)
})

test('a stale hover cannot become a first drag input during a modifier-only transition', async () => {
  const n = vector(), before = await render([n]); await act(async () => { editor.select([n.id]); editor.set({ tool: 'vector' }) })
  await act(async () => pointer('pointermove', 65, 75))
  await act(async () => pointer('pointerdown', 100, 100, {}, mount.querySelector('[data-testid="vector-anchor"]')!))
  await act(async () => key('Control', { ctrlKey: true }))
  expect(editor.state.doc).toBe(before)
  await flushFrames(); expect(editor.state.doc).toBe(before)
  await act(async () => pointer('pointerup', 100, 100, { ctrlKey: true }))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

// Audit: real DOM wheel handler -> pending camera -> first frame publication.
test.each([1, 10, 120])('zoom audit accumulates %i native pinch samples without losing scale or adding a second input frame', async count => {
  await render([])
  const doc = editor.state.doc, version = editor.state.version
  const start = { x: 0, y: 0, zoom: 1 }
  await act(async () => editor.set({ view: start }))
  const panel = editor.panelSnapshot()
  const samples: { zoom: number; pinch: boolean }[] = []
  const unbindInput = bindNavigationInput(editor, { enabled: () => true, record: (_event, _size, view, pinch) => { samples.push({ zoom: view.zoom, pinch }) } })
  const anchor = { x: 317.25, y: 442.5 }
  const notices: number[] = [], unsubscribe = editor.subscribe(() => notices.push(editor.state.view.zoom))
  await act(async () => {
    for (let i = 0; i < count; i++) host().dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: anchor.x, clientY: anchor.y,
      ctrlKey: true, deltaX: 0, deltaY: -100 * Math.log(2) / count, deltaMode: 0,
    }))
  })
  expect(samples).toHaveLength(count)
  expect(samples.at(-1)!.zoom).toBeCloseTo(2, 12)
  expect(samples.every(sample => sample.pinch)).toBe(true)
  expect(editor.state.view.zoom).toBe(1)
  expect(editor.effectiveView().zoom).toBeCloseTo(2, 12)
  await flushFrames(1000 / 60)
  expect(editor.state.view.zoom).toBeCloseTo(2, 12)
  expect(editor.state.view.x + anchor.x * editor.state.view.zoom).toBeCloseTo(anchor.x, 9)
  expect(editor.state.view.y + anchor.y * editor.state.view.zoom).toBeCloseTo(anchor.y, 9)
  expect(notices).toHaveLength(1)
  expect(editor.panelSnapshot()).toBe(panel)
  expect(editor.state.doc).toBe(doc)
  expect(editor.state.version).toBe(version)
  unbindInput(); unsubscribe()
})
