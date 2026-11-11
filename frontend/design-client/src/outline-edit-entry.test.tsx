// Mounted Canvas, real Editor, and the dev WASM kernel. The render device is
// replaced; anchor elements, vertex coordinates, history, FD bytes, and CPU
// raster samples are not. No Electron, Metal, or hardware-GPU claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { editableNetwork } from './editable-network'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { apply, worldMatrix } from './geometry'
import { forma_decode_json, forma_encode_json, validate_document_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, validateDocument, type DesignDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'

// React must detect DOM input event support before its module is evaluated.
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

let dom: JSDOM, root: Root, mount: HTMLDivElement, editor: Editor, errors: unknown[][]
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
  localStorage.clear(); interfacePreference.reset(); shortcutPreference.set('figma-like')
  editor = new Editor(blank()); editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(errors).toEqual([])
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}, target: Element = host(), pointerId = 7) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  target.dispatchEvent(event); return event
}
function key(value: string, options: KeyboardEventInit = {}, type = 'keydown', target: EventTarget = host()) {
  const event = new KeyboardEvent(type, { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
async function moveTo(x: number, y: number) {
  await act(async () => {
    pointer('pointermove', x, y)
    const pending = [...frames.values()]; frames.clear()
    for (const frame of pending) frame(performance.now())
  })
}
function place(nodes: DesignNode[]) {
  const doc = blank('Outline entry')
  const children = new Set(nodes.flatMap(item => item.children))
  for (const item of nodes) doc.nodes[item.id] = item
  doc.pages[0].children = nodes.filter(item => !children.has(item.id)).map(item => item.id)
  return doc
}
async function show(doc: DesignDocument) {
  editor.load(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, tool: 'select', selection: [] })
  await act(async () => {
    root.render(<Canvas editor={editor} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  await act(async () => editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false }))
  host().focus()
  return editor.state.doc
}
function useLayout(mode: 'figma' | 'sketch') {
  applyInterfaceLayout(mode)
  expect(interfacePreference.getSnapshot().uiMode).toBe(mode)
  expect(shortcutPreference.getSnapshot()).toBe(mode === 'sketch' ? 'sketch-like' : 'figma-like')
}
function anchors() {
  return [...mount.querySelectorAll<SVGRectElement>('[data-testid="vector-anchor"]')].map(element => {
    const zoom = editor.state.view.zoom
    return {
      id: element.getAttribute('data-node-id'),
      x: Number(element.getAttribute('x')) + 4 / zoom,
      y: Number(element.getAttribute('y')) + 4 / zoom,
      hidden: element.closest('[visibility="hidden"]') !== null,
    }
  })
}
function expectHandles(id: string, source: DesignNode) {
  const draft = editableNetwork(source)
  const seen = anchors()
  expect(seen.map(item => item.id)).toEqual(draft.vertices.map(() => id))
  expect(seen.every(item => !item.hidden)).toBe(true)
  expect(seen.map(item => [item.x, item.y])).toEqual(draft.vertices.map(vertex => [vertex.x, vertex.y]))
  expect(host().className).toContain('canvas-vector')
  return draft
}
function quiet(before: DesignDocument, id: string, kind: DesignNode['kind']) {
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc.nodes[id].kind).toBe(kind)
  expect(editor.state.doc.nodes[id].network).toBe(before.nodes[id].network)
}
function world(id: string, local: { x: number; y: number }) {
  return apply(worldMatrix(editor.state.doc, id), local)
}
function raster(document: DesignDocument) {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    return engine.render_rgba(JSON.stringify({
      pageId: document.pages[0].id, width: 96, height: 96,
      view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic',
    }))
  } finally { engine.free() }
}
function changedPixels(left: Uint8Array, right: Uint8Array) {
  expect(left.length).toBe(right.length)
  expect(left.length).toBe(96 * 96 * 4)
  let count = 0
  for (let i = 0; i < left.length; i += 4)
    if (left[i] !== right[i] || left[i + 1] !== right[i + 1] || left[i + 2] !== right[i + 2] || left[i + 3] !== right[i + 3]) count++
  return count
}
function evidence(record: Record<string, unknown>) {
  if (process.env.OUTLINE_EDIT_EVIDENCE) appendFileSync('/tmp/outline-edit-evidence.jsonl', `${JSON.stringify(record)}\n`)
}
function reopen(document: DesignDocument) {
  const encoded = forma_encode_json(JSON.stringify(document))
  const decoded = validateDocument(JSON.parse(forma_decode_json(encoded)))
  validate_document_json(JSON.stringify(decoded))
  return { decoded, bytes: encoded.byteLength }
}

test.each(['figma', 'sketch'] as const)('%s: Enter and double-click expose outline handles and do not edit the document', async (mode) => {
  useLayout(mode)
  const rectangle = node('rectangle', 16, 18, 40, 30)
  const ellipse = node('ellipse', 90, 18, 40, 24)
  const path = node('vector', 160, 22, 48, 16)
  path.network = {
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 48, y: 16 }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }], fillRule: 'nonzero',
  }
  const before = await show(place([rectangle, ellipse, path]))
  const pixels = raster(before)

  await act(async () => editor.select([rectangle.id]))
  await act(async () => key('Enter'))
  const rectangleDraft = expectHandles(rectangle.id, before.nodes[rectangle.id])
  expect(rectangleDraft.vertices.map(vertex => [vertex.x, vertex.y])).toEqual([[40, 0], [40, 30], [0, 30], [0, 0]])
  quiet(before, rectangle.id, 'rectangle')
  await act(async () => key('Enter'))
  expect(anchors()).toEqual([])
  expect(editor.state.tool).toBe('select')
  quiet(before, rectangle.id, 'rectangle')

  await act(async () => editor.select([ellipse.id]))
  const center = world(ellipse.id, { x: 20, y: 12 })
  await act(async () => host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: center.x, clientY: center.y, button: 0 })))
  const ellipseDraft = expectHandles(ellipse.id, before.nodes[ellipse.id])
  expect(ellipseDraft.vertices.map(vertex => [vertex.x, vertex.y])).toEqual([[40, 12], [20, 24], [0, 12], [20, 0]])
  expect(ellipseDraft.edges.every(edge => edge.c1 && edge.c2)).toBe(true)
  quiet(before, ellipse.id, 'ellipse')
  await act(async () => key('Escape'))
  expect(anchors()).toEqual([])
  expect(editor.state.selection).toEqual([ellipse.id])
  quiet(before, ellipse.id, 'ellipse')

  await act(async () => editor.select([path.id]))
  await act(async () => key('Enter'))
  expectHandles(path.id, before.nodes[path.id])
  expect(editor.state.doc.nodes[path.id].network).toBe(before.nodes[path.id].network)
  quiet(before, path.id, 'vector')
  const vertex = world(path.id, { x: 0, y: 0 })
  await act(async () => { editor.set({ tool: 'select' }); host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: vertex.x, clientY: vertex.y, button: 0 })) })
  expectHandles(path.id, before.nodes[path.id])
  quiet(before, path.id, 'vector')
  expect(raster(editor.state.doc)).toEqual(pixels)
  evidence({ mode, rectangleAnchors: 4, ellipseAnchors: 4, networkAnchors: 2, pixels: pixels.length, dirty: false })
})

test.each([
  ['figma', 'rectangle', 12, 0],
  ['sketch', 'ellipse', 8, 0],
] as const)('%s: the first %s anchor move is one undo back to the original shape', async (mode, kind, dx, dy) => {
  useLayout(mode)
  const shape = node(kind, 8, 10, kind === 'ellipse' ? 36 : 40, kind === 'ellipse' ? 24 : 30)
  const before = await show(place([shape]))
  const original = structuredClone(before.nodes[shape.id])
  const originalPixels = raster(before)
  await act(async () => { editor.select([shape.id]); key('Enter') })
  const draft = expectHandles(shape.id, before.nodes[shape.id])
  expect(raster(editor.state.doc)).toEqual(originalPixels)
  const local = draft.vertices[0]
  const anchor = [...mount.querySelectorAll<SVGElement>('[data-testid="vector-anchor"]')].find(element => {
    const zoom = editor.state.view.zoom
    return Math.abs(Number(element.getAttribute('x')) + 4 / zoom - local.x) < 1e-6
      && Math.abs(Number(element.getAttribute('y')) + 4 / zoom - local.y) < 1e-6
  })
  expect(anchor).toBeTruthy()
  const start = world(shape.id, local)
  await act(async () => pointer('pointerdown', start.x, start.y, {}, anchor!))
  await act(async () => pointer('pointerup', start.x, start.y))
  quiet(before, shape.id, kind)
  expect(anchors()).toHaveLength(draft.vertices.length)

  await act(async () => pointer('pointerdown', start.x, start.y, {}, anchor!))
  await moveTo(start.x + dx, start.y + dy)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc.nodes[shape.id].kind).toBe('vector')
  expect(editor.state.doc.nodes[shape.id].network!.vertices[0]).toMatchObject({ x: local.x + dx, y: local.y + dy })
  await moveTo(start.x, start.y)
  await act(async () => pointer('pointerup', start.x, start.y))
  quiet(before, shape.id, kind)

  const liveAnchor = [...mount.querySelectorAll<SVGElement>('[data-testid="vector-anchor"]')].find(element => {
    const zoom = editor.state.view.zoom
    return Math.abs(Number(element.getAttribute('x')) + 4 / zoom - local.x) < 1e-6
      && Math.abs(Number(element.getAttribute('y')) + 4 / zoom - local.y) < 1e-6
  })!
  await act(async () => pointer('pointerdown', start.x, start.y, {}, liveAnchor))
  await moveTo(start.x + dx, start.y + dy)
  await act(async () => pointer('pointerup', start.x + dx, start.y + dy))
  const edited = editor.state.doc
  const nodeAfter = edited.nodes[shape.id]
  expect(nodeAfter.kind).toBe('vector')
  expect(nodeAfter.network!.vertices[0]).toMatchObject({ id: local.id, x: local.x + dx, y: local.y + dy })
  expect(nodeAfter.network!.vertices.slice(1).map(vertex => [vertex.x, vertex.y])).toEqual(draft.vertices.slice(1).map(vertex => [vertex.x, vertex.y]))
  expect(nodeAfter.vectorGeometry).toBeUndefined()
  expect(nodeAfter.arc).toBeUndefined()
  expect(editor.canUndo).toBe(true)
  expect(editor.canRedo).toBe(false)
  const editedPixels = raster(edited)
  const movedPixels = changedPixels(originalPixels, editedPixels)
  expect(movedPixels).toBeGreaterThan(0)
  const reopened = reopen(edited)
  expect(reopened.decoded.nodes[shape.id].kind).toBe('vector')
  expect(reopened.decoded.nodes[shape.id].network!.vertices[0]).toMatchObject({ x: local.x + dx, y: local.y + dy })

  await act(async () => editor.undo())
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(true)
  expect(editor.state.doc.nodes[shape.id]).toEqual(original)
  expect(raster(editor.state.doc)).toEqual(originalPixels)
  await act(async () => { editor.select([shape.id]); key('Enter'); key('Escape') })
  expect(editor.state.tool).toBe('select')
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(true)
  expect(editor.state.doc.nodes[shape.id]).toEqual(original)
  await act(async () => editor.redo())
  expect(editor.state.doc.nodes[shape.id].network!.vertices[0]).toMatchObject({ x: local.x + dx, y: local.y + dy })
  expect(raster(editor.state.doc)).toEqual(editedPixels)
  evidence({ mode, kind, anchors: draft.vertices.length, dx, dy, movedPixels, fdBytes: reopened.bytes, undoEntries: 1 })
})

test('network Enter moves one vertex and one undo restores that network', async () => {
  useLayout('figma')
  const path = node('vector', 12, 20, 40, 16)
  path.network = {
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 40, y: 16 }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }], fillRule: 'nonzero',
  }
  const before = await show(place([path]))
  const original = structuredClone(before.nodes[path.id].network)
  const originalPixels = raster(before)
  await act(async () => { editor.select([path.id]); key('Enter') })
  expectHandles(path.id, before.nodes[path.id])
  expect(editor.state.doc.nodes[path.id].network).toBe(before.nodes[path.id].network)
  const anchor = mount.querySelector<SVGElement>('[data-testid="vector-anchor"]')!
  const start = world(path.id, { x: 0, y: 0 })
  await act(async () => pointer('pointerdown', start.x, start.y, {}, anchor))
  await moveTo(start.x + 7, start.y + 4)
  await act(async () => pointer('pointerup', start.x + 7, start.y + 4))
  expect(editor.state.doc.nodes[path.id].network!.vertices[0]).toEqual({ id: 'a', x: 7, y: 4 })
  expect(editor.state.doc.nodes[path.id].network!.vertices[1]).toEqual(original!.vertices[1])
  const movedPixels = changedPixels(originalPixels, raster(editor.state.doc))
  expect(movedPixels).toBeGreaterThan(0)
  await act(async () => editor.undo())
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc.nodes[path.id].network).toEqual(original)
  expect(raster(editor.state.doc)).toEqual(originalPixels)
  evidence({ mode: 'figma', kind: 'network', anchors: 2, dx: 7, dy: 4, movedPixels, undoEntries: 1 })
})

test('text, frames, locked shapes, and in-progress drags keep their existing Enter behavior', async () => {
  useLayout('sketch')
  const text = node('text', 16, 16, 80, 36)
  const frame = node('frame', 120, 16, 150, 90), child = node('rectangle', 18, 16, 36, 28)
  frame.children = [child.id]
  const locked = node('rectangle', 300, 20, 40, 30); locked.locked = true
  const group = node('group', 16, 140, 120, 50), left = node('rectangle', 8, 8, 24, 24), right = node('ellipse', 48, 8, 24, 24)
  group.children = [left.id, right.id]
  const lockedParent = node('group', 300, 140, 80, 60), lockedChild = node('ellipse', 8, 8, 40, 30)
  lockedParent.locked = true; lockedParent.children = [lockedChild.id]
  const mover = node('rectangle', 16, 220, 50, 32)
  const before = await show(place([text, frame, child, locked, group, left, right, lockedParent, lockedChild, mover]))

  await act(async () => { editor.select([text.id]); key('Enter') })
  const field = mount.querySelector('textarea[aria-label="画布文字编辑"]')
  expect(field).not.toBeNull()
  expect((field as HTMLTextAreaElement).value).toBe(text.text)
  expect(anchors()).toEqual([])
  expect(editor.state.tool).toBe('select')
  quiet(before, text.id, 'text')
  await act(async () => key('Escape', {}, 'keydown', field!))
  expect(mount.querySelector('textarea[aria-label="画布文字编辑"]')).toBeNull()
  expect(editor.state.doc).toBe(before)

  await act(async () => { editor.select([frame.id]); key('Enter') })
  expect(editor.state.selection).toEqual([child.id])
  expect(editor.state.tool).toBe('select')
  expect(anchors()).toEqual([])
  quiet(before, frame.id, 'frame')
  await act(async () => key('Enter', { shiftKey: true }))
  expect(editor.state.selection).toEqual([frame.id])
  expect(anchors()).toEqual([])

  await act(async () => { editor.select([child.id]); key('Enter') })
  expectHandles(child.id, before.nodes[child.id])
  quiet(before, child.id, 'rectangle')
  await act(async () => key('Enter', { shiftKey: true }))
  expect(editor.state.selection).toEqual([frame.id])
  expect(editor.state.tool).toBe('select')
  expect(anchors()).toEqual([])
  quiet(before, child.id, 'rectangle')

  const childCenter = world(child.id, { x: 18, y: 14 })
  await act(async () => host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: childCenter.x, clientY: childCenter.y, button: 0 })))
  expect(editor.state.selection).toEqual([child.id])
  expect(editor.state.tool).toBe('select')
  expect(anchors()).toEqual([])
  await act(async () => host().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: childCenter.x, clientY: childCenter.y, button: 0 })))
  expectHandles(child.id, before.nodes[child.id])
  quiet(before, child.id, 'rectangle')

  await act(async () => { editor.set({ tool: 'select' }); editor.select([locked.id]); key('Enter') })
  expect(editor.state.tool).toBe('select')
  expect(editor.state.selection).toEqual([locked.id])
  expect(anchors()).toEqual([])
  quiet(before, locked.id, 'rectangle')

  await act(async () => { editor.select([left.id, right.id]); key('Enter') })
  expect(new Set(editor.state.selection)).toEqual(new Set([left.id, right.id]))
  expect(editor.state.tool).toBe('select')
  expect(anchors()).toEqual([])
  await act(async () => { editor.select([group.id]); key('Enter') })
  expect(new Set(editor.state.selection)).toEqual(new Set([left.id, right.id]))
  expect(anchors()).toEqual([])
  await act(async () => { editor.select([lockedChild.id]); key('Enter') })
  expect(editor.state.tool).toBe('select')
  expect(editor.state.selection).toEqual([lockedChild.id])
  expect(anchors()).toEqual([])
  const from = world(mover.id, { x: 10, y: 10 })
  await act(async () => { editor.select([mover.id]); pointer('pointerdown', from.x, from.y) })
  await act(async () => key('Enter'))
  expect(editor.state.tool).toBe('select')
  expect(anchors()).toEqual([])
  await act(async () => pointer('pointerup', from.x, from.y))
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
})
