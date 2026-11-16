// Linux jsdom + the debug kernel. This does not open Electron or native Sketch.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank, node, stroke, uid, type DesignDocument, type DesignNode } from './model'
import { shortcutPreference } from './shortcut-preference'
import { interfacePreference } from './interface-preference'
import { dispatchEditorCommand } from './editor-commands'
import { export_sketch_json } from './generated/design-kernel/design_kernel'
import { defaultPencil, freehandNode } from './freehand'

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
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {},
  })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  localStorage.clear()
  interfacePreference.reset()
  shortcutPreference.set('sketch-like')
  interfacePreference.set({ uiMode: 'sketch', locale: 'zh-CN' })
  editor = new Editor(blank())
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, selection: [] })
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(errors).toEqual([])
})

const host = () => mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function render(nodes: DesignNode[] = []) {
  const doc = blank('Pencil style')
  doc.nodes = Object.fromEntries(nodes.map(item => [item.id, item]))
  doc.pages[0].children = nodes.map(item => item.id)
  editor.load(doc)
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false, selection: [] })
  await act(async () => {
    root.render(<Canvas editor={editor} />)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
  host().focus()
  return editor.state.doc
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  host().dispatchEvent(event)
}
async function pressPencil() {
  await act(async () => {
    host().focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', code: 'KeyP', bubbles: true, cancelable: true,
    }))
  })
}
function setInputValue(input: HTMLInputElement, value: string) {
  const prototype = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')
  const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue(value: string): void } })._valueTracker
  tracker?.setValue(input.value)
  prototype?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
async function draw(points: ReadonlyArray<readonly [number, number]>, options: MouseEventInit = {}) {
  await act(async () => { editor.select([]) })
  const [start, ...rest] = points
  const end = rest.at(-1) ?? start
  await act(async () => pointer('pointerdown', start[0], start[1], options))
  for (const [x, y] of rest) await act(async () => pointer('pointermove', x, y, options))
  await act(async () => pointer('pointerup', end[0], end[1], options))
  const id = editor.state.selection[0]
  return editor.state.doc.nodes[id]
}
function styleOf(item: DesignNode) {
  const authored = item.strokes[0]
  return {
    name: item.name,
    fills: item.fills.length,
    width: authored?.width,
    color: authored?.paint.color,
    opacity: authored?.paint.opacity,
    cap: authored?.cap,
    join: authored?.join,
    align: authored?.align,
    dash: authored?.dash,
    edges: item.network?.edges.length ?? 0,
  }
}
const NATIVE = { width: 1, color: '#979797', opacity: 1, cap: 'butt', join: 'miter', align: 'center', dash: '', fills: 0, name: '铅笔路径' }
function sketchPencilLayers(document: DesignDocument) {
  const files = unzipSync(export_sketch_json(JSON.stringify(document)))
  const page = Object.entries(files).find(([path]) => path.startsWith('pages/') && path.endsWith('.json'))
  if (!page) throw new Error('exported sketch has no page')
  const decoded = JSON.parse(new TextDecoder().decode(page[1])) as { layers?: SketchLayer[] }
  const found: SketchLayer[] = []
  const walk = (layers: SketchLayer[] | undefined) => {
    for (const layer of layers ?? []) {
      if (layer.name === '铅笔路径') found.push(layer)
      walk(layer.layers)
    }
  }
  walk(decoded.layers)
  return found.map(layer => {
    const border = layer.style?.borders?.[0]
    return {
      className: layer._class,
      thickness: border?.thickness,
      enabled: border?.isEnabled,
      red: border?.color?.red,
      green: border?.color?.green,
      blue: border?.color?.blue,
      alpha: border?.color?.alpha,
      cap: layer.style?.borderOptions?.lineCapStyle,
      join: layer.style?.borderOptions?.lineJoinStyle,
    }
  })
}
type SketchLayer = {
  _class?: string
  name?: string
  layers?: SketchLayer[]
  style?: {
    borders?: { thickness?: number; isEnabled?: boolean; color?: { red?: number; green?: number; blue?: number; alpha?: number } }[]
    borderOptions?: { lineCapStyle?: number; lineJoinStyle?: number }
  }
}
const CHANNEL = 0x97 / 255

test('sketch layout pencil uses the native default on a straight stroke and a cornered stroke', async () => {
  await render([])
  expect(editor.state.selection).toEqual([])
  await pressPencil()
  expect(editor.state.tool).toBe('pencil')
  const straight = await draw([[40, 80], [120, 80], [200, 80]], { shiftKey: true })
  const corner = await draw([[40, 220], [100, 220], [160, 220], [160, 290], [160, 360]])
  let exported: ReturnType<typeof sketchPencilLayers> | string
  try { exported = sketchPencilLayers(editor.state.doc) } catch (error) { exported = String(error) }
  expect({
    control: host().querySelector<HTMLInputElement>('input[type="color"]')?.value,
    pencil: editor.state.pencil,
    straight: styleOf(straight),
    corner: styleOf(corner),
    exported,
  }).toEqual({
    control: '#979797',
    pencil: { width: 1, color: '#979797', smoothing: 0.8, pressure: false },
    straight: { ...NATIVE, edges: 1 },
    corner: { ...NATIVE, edges: 2 },
    exported: [0, 1].map(() => ({
      className: 'shapePath',
      thickness: 1,
      enabled: true,
      red: CHANNEL,
      green: CHANNEL,
      blue: CHANNEL,
      alpha: 1,
      cap: 0,
      join: 0,
    })),
  })
  expect(straight.network!.edges).toHaveLength(1)
  expect(corner.network!.edges.length).toBeGreaterThan(1)
  for (const point of straight.network!.vertices) expect(point.y).toBeCloseTo(straight.network!.vertices[0].y, 6)
  const [start, end] = [corner.network!.vertices[0], corner.network!.vertices.at(-1)!]
  const span = Math.hypot(end.x - start.x, end.y - start.y)
  expect(corner.network!.vertices.some(point =>
    Math.abs((point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x)) / Math.max(span, 1e-9) > 1,
  )).toBe(true)
})

test('a hand-set pencil color and width, and a sampled stroke, survive the next sketch strokes', async () => {
  const source = node('rectangle', 420, 300, 120, 80)
  source.name = '已有描边'
  source.strokes = [{ ...stroke('#e11d48', 6), cap: 'square', join: 'bevel' }]
  await render([source])
  await pressPencil()
  const color = host().querySelector<HTMLInputElement>('input[aria-label="画笔颜色"]')!
  const width = host().querySelector<HTMLInputElement>('input[aria-label="笔宽"]')!
  await act(async () => { setInputValue(color, '#112233') })
  await act(async () => {
    width.focus()
    setInputValue(width, '4')
    width.blur()
  })
  const adjusted = await draw([[30, 40], [90, 40], [150, 40]], { shiftKey: true })
  await act(async () => pointer('pointerdown', 480, 340, { metaKey: true }))
  const sampledMessage = editor.state.message
  const sampled = await draw([[30, 140], [90, 180], [150, 140]])
  await act(async () => { setInputValue(color, '#00aa00') })
  const recolored = await draw([[30, 240], [120, 240]])
  expect({
    message: sampledMessage,
    adjusted: styleOf(adjusted),
    sampled: styleOf(sampled),
    recolored: styleOf(recolored),
    source: editor.state.doc.nodes[source.id].strokes[0],
  }).toMatchObject({
    message: '已取样描边颜色、宽度、端点与连接',
    adjusted: { width: 4, color: '#112233', cap: 'butt', join: 'miter' },
    sampled: { width: 6, color: '#e11d48', cap: 'square', join: 'bevel' },
    recolored: { width: 6, color: '#00aa00', cap: 'square', join: 'bevel' },
  })
  expect(editor.state.doc.nodes[source.id].strokes[0]).toMatchObject({ width: 6, cap: 'square', join: 'bevel', paint: { color: '#e11d48' } })
})

test('figma pencil stays black and round, and an edited sketch color is not replaced by the layout default', async () => {
  interfacePreference.set({ uiMode: 'figma', locale: 'zh-CN' })
  shortcutPreference.set('figma-like')
  await render([])
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-pencil') })
  const figma = await draw([[20, 20], [80, 20], [140, 20]])
  expect(styleOf(figma)).toMatchObject({ width: 1, color: '#000000', cap: 'round', join: 'round' })
  expect(editor.state.pencil).toEqual(defaultPencil())
  await act(async () => {
    interfacePreference.set({ uiMode: 'sketch' })
    shortcutPreference.set('sketch-like')
  })
  expect(editor.state.pencil.color).toBe('#979797')
  await act(async () => { interfacePreference.set({ uiMode: 'figma' }) })
  expect(editor.state.pencil.color).toBe('#000000')
  await act(async () => { editor.set({ pencil: { ...editor.state.pencil, color: '#112233' } }) })
  await act(async () => { interfacePreference.set({ uiMode: 'sketch' }) })
  expect(editor.state.pencil.color).toBe('#112233')
  const kept = await draw([[20, 80], [100, 120], [180, 80]])
  expect(styleOf(kept)).toMatchObject({ color: '#112233', cap: 'butt', join: 'miter', width: 1 })
})

test('sketch brush strokes keep their own color and round ends', async () => {
  await render([])
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-brush') })
  const drawn = await draw([[20, 20], [60, 40], [100, 20]])
  expect(styleOf(drawn)).toMatchObject({ color: '#7451ca', width: 12, cap: 'round', join: 'round' })
  expect(editor.state.pencil.color).toBe('#979797')
})

test('freehandNode applies sketch ends only for an uncustomized pencil', () => {
  const samples = [{ x: 0, y: 0, pressure: 0.5 }, { x: 40, y: 0, pressure: 0.5 }, { x: 40, y: 30, pressure: 0.5 }]
  const created = freehandNode(uid(), samples, defaultPencil(), 1, 'pencil', 'sketch')
  expect(styleOf(created)).toMatchObject({ color: '#000000', cap: 'butt', join: 'miter', width: 1 })
  const tuned = freehandNode(uid(), samples, { ...defaultPencil(), color: '#112233', width: 3, cap: 'round', join: 'round' }, 1, 'pencil', 'sketch')
  expect(styleOf(tuned)).toMatchObject({ color: '#112233', width: 3, cap: 'round', join: 'round' })
  const figma = freehandNode(uid(), samples, defaultPencil(), 1, 'pencil', 'figma')
  expect(styleOf(figma)).toMatchObject({ color: '#000000', cap: 'round', join: 'round' })
})
