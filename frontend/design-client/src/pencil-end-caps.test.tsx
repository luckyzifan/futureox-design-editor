// Figma-layout pencil caps before a stroke. CPU analytic raster and stroke
// outlines are the measured shape; this is not a macOS or desktop Figma pixel match.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { Editor } from './engine'
import { dispatchEditorCommand } from './editor-commands'
import { PencilInput, defaultBrush, defaultPencil, freehandNode, type PencilCap } from './freehand'
import { interfacePreference } from './interface-preference'
import { kernelStrokeContours } from './kernel/picking'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, uid, type DesignNode } from './model'
import { PendingEditContext } from './pending-edit-context'

const straight = Array.from({ length: 21 }, (_, index) => ({ x: index * 10, y: 80, pressure: 0.5 }))

function horizontalEnds(node: DesignNode) {
  const vertices = node.network?.vertices
  if (!vertices || vertices.length < 2) throw new Error('pencil stroke has no open ends')
  const start = vertices[0], end = vertices[vertices.length - 1]
  if (!(end.x > start.x + 50) || Math.abs(end.y - start.y) > 0.05)
    throw new Error(`expected a long horizontal stroke, got ${start.x},${start.y} -> ${end.x},${end.y}`)
  return { start, end }
}

function outlineCap(node: DesignNode): PencilCap {
  const { start, end } = horizontalEnds(node)
  const points = kernelStrokeContours(node).flat(2)
  if (points.length < 4) throw new Error('stroke outline is empty')
  const half = node.strokes[0].width / 2
  const before = start.x - Math.min(...points.map(point => point.x))
  const after = Math.max(...points.map(point => point.x)) - end.x
  const cornerGap = Math.min(...points.map(point => Math.hypot(point.x - (end.x + half), point.y - (end.y + half))))
  const tipGap = Math.min(...points.map(point => Math.hypot(point.x - (end.x + half), point.y - end.y)))
  if (before < 0.05 && after < 0.05) return 'butt'
  if (Math.abs(before - half) < 0.02 && Math.abs(after - half) < 0.02 && cornerGap < 0.05) return 'square'
  if (before > half * 0.95 && before <= half + 0.02 && after > half * 0.95 && after <= half + 0.02 && cornerGap > half * 0.3 && tipGap < 0.05) return 'round'
  throw new Error(`unrecognized cap outline before=${before} after=${after} half=${half} corner=${cornerGap} tip=${tipGap}`)
}

function rasterCap(engine: VectorEngine, node: DesignNode, which: 'start' | 'end'): PencilCap {
  const { start, end } = horizontalEnds(node)
  const vertex = which === 'start' ? start : end
  const sign = which === 'start' ? -1 : 1
  const world = { x: node.transform[4] + vertex.x, y: node.transform[5] + vertex.y }
  const zoom = 4, width = 160, height = 160, cx = 80, cy = 80
  const radius = node.strokes[0].width / 2 * zoom
  const doc = blank('cap probe')
  doc.nodes[node.id] = node
  doc.pages[0].children = [node.id]
  engine.load_document(JSON.stringify(doc))
  const pixels = engine.render_rgba(JSON.stringify({
    pageId: doc.pages[0].id, width, height,
    view: { x: cx - world.x * zoom, y: cy - world.y * zoom, zoom },
    transparent: true, grid: false, rasterProfile: 'analytic',
  }))
  const at = (x: number, y: number) => pixels[(Math.round(y) * width + Math.round(x)) * 4 + 3]
  const sample = (along: number, across: number) => at(cx + sign * along, cy + across)
  const seen = {
    body: sample(-8, 0),
    past: sample(2, 0),
    axis: sample(Math.round(radius * 0.65), 0),
    corner: sample(radius - 1, -(radius - 1)),
    outside: sample(radius + 3, -(radius + 3)),
  }
  if (seen.body !== 255 || seen.outside !== 0) throw new Error(`cap raster missed the stroke ${JSON.stringify(seen)}`)
  if (seen.past === 0 && seen.axis === 0 && seen.corner === 0) return 'butt'
  if (seen.past === 255 && seen.axis === 255 && seen.corner === 255) return 'square'
  if (seen.past === 255 && seen.axis === 255 && seen.corner === 0) return 'round'
  throw new Error(`unrecognized cap pixels ${which} ${JSON.stringify(seen)}`)
}

test('a pencil stroke keeps the cap chosen before it, including both magnified ends', () => {
  const engine = new VectorEngine()
  try {
    for (const cap of ['butt', 'square', 'round'] as const) {
      const node = freehandNode(uid(), straight, { ...defaultPencil(), width: 20, cap }, 1, 'pencil')
      expect(node.strokes[0].cap).toBe(cap)
      expect(outlineCap(node)).toBe(cap)
      expect(rasterCap(engine, node, 'start')).toBe(cap)
      expect(rasterCap(engine, node, 'end')).toBe(cap)
    }
    const input = new PencilInput(1, false)
    const identity = (point: { clientX: number; clientY: number }) => ({ x: point.clientX, y: point.clientY })
    input.append(straight.map(sample => ({ ...sample, clientX: sample.x, clientY: sample.y, pointerId: 1, pointerType: 'mouse' })), identity, false, true)
    const shifted = freehandNode(uid(), input.samples, { ...defaultPencil(), width: 20, cap: 'square' }, 1, 'pencil')
    expect(shifted.strokes[0].cap).toBe('square')
    expect(outlineCap(shifted)).toBe('square')
    const brush = freehandNode(uid(), straight, { ...defaultBrush(), width: 20, pressure: false, cap: 'square' }, 1, 'brush')
    expect(brush.strokes[0].cap).toBe('round')
    expect(brush.strokes[0].widthProfile).toBeUndefined()
    const tape = freehandNode(uid(), straight, { ...defaultPencil(), width: 20, cap: 'butt' }, 1, 'washi-tape')
    expect(tape.strokes[0].cap).toBe('square')
    expect(tape.strokes[0].join).toBe('bevel')
    const { cap: _cap, ...withoutCap } = defaultPencil()
    expect(freehandNode(uid(), straight, { ...withoutCap, width: 20 }, 1, 'pencil').strokes[0].cap).toBe('round')
    expect(() => freehandNode(uid(), straight, { ...defaultPencil(), cap: 'arrow' as PencilCap }, 1, 'pencil')).toThrow('无效的画笔设置')
  } finally { engine.free() }
})

test('undo and tool changes keep each pencil stroke cap on that stroke', () => {
  const editor = new Editor(blank())
  editor.set({ tool: 'pencil', pencil: { ...defaultPencil(), width: 20, cap: 'butt' } })
  const butt = freehandNode(uid(), straight, editor.state.pencil, 1, 'pencil')
  editor.addFreehand(butt)
  editor.set({ pencil: { ...editor.state.pencil, cap: 'square' } })
  const square = freehandNode(uid(), straight.map(sample => ({ ...sample, y: sample.y + 80 })), editor.state.pencil, 1, 'pencil')
  editor.addFreehand(square)
  expect(editor.state.doc.nodes[butt.id].strokes[0].cap).toBe('butt')
  expect(editor.state.doc.nodes[square.id].strokes[0].cap).toBe('square')
  editor.set({ tool: 'brush' })
  expect(editor.state.doc.nodes[butt.id].strokes[0].cap).toBe('butt')
  expect(editor.state.pencil.cap).toBe('square')
  editor.undo()
  expect(editor.state.tool).toBe('select')
  expect(editor.state.doc.nodes[square.id]).toBeUndefined()
  expect(editor.state.doc.nodes[butt.id].strokes[0].cap).toBe('butt')
  expect(editor.state.pencil.cap).toBe('square')
  editor.redo()
  expect(editor.state.doc.nodes[square.id].strokes[0].cap).toBe('square')
  expect(editor.state.doc.nodes[butt.id].strokes[0].cap).toBe('butt')
  expect(editor.state.pencil.cap).toBe('square')
  editor.dispose()
})

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => {
      props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false })
    }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})

test('the Figma right rail sets each pencil cap before the stroke and can still edit it afterward', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const errors: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  interfacePreference.reset()
  const editor = new Editor(blank('Pencil caps'))
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  const mount = document.createElement('div')
  document.body.append(mount)
  const root: Root = createRoot(mount)
  const rail = () => document.querySelector('aside.inspector')!
  const capButton = (label: string) => rail().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const labels = { butt: 'No end cap', square: 'End cap square', round: 'End cap round' } as const
  const host = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
    host().dispatchEvent(event)
  }
  const flushFrames = async () => {
    await act(async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(0) } })
  }
  const choose = async (cap: PencilCap) => {
    await act(async () => { editor.select([]) })
    const button = capButton(labels[cap])
    expect(button, labels[cap]).not.toBeNull()
    await act(async () => { button!.click() })
    expect(editor.state.pencil.cap).toBe(cap)
    expect(capButton(labels[cap])!.getAttribute('aria-checked')).toBe('true')
  }
  const draw = async (y: number) => {
    const before = editor.state.doc.pages[0].children.length
    await act(async () => pointer('pointerdown', 20, y))
    for (let step = 1; step <= 12; step++) await act(async () => pointer('pointermove', 20 + step * 16, y))
    await flushFrames()
    await act(async () => pointer('pointerup', 20 + 12 * 16, y))
    expect(editor.state.doc.pages[0].children).toHaveLength(before + 1)
    const id = editor.state.selection[0]
    return editor.state.doc.nodes[id]
  }
  const engine = new VectorEngine()
  try {
    await act(async () => {
      interfacePreference.set({ locale: 'en', uiMode: 'figma' })
      root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor} /><Inspector editor={editor} /></PendingEditContext.Provider>)
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    await act(async () => { await dispatchEditorCommand(editor, 'set-tool-pencil') })
    await act(async () => { editor.set({ pencil: { ...editor.state.pencil, width: 20 } }) })
    expect(editor.state.tool).toBe('pencil')
    expect([...rail().querySelectorAll('h3')].map(heading => heading.textContent)).toContain('Stroke')
    expect(capButton(labels.round)!.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.pencil-controls [aria-label="No end cap"]')).toBeNull()
    expect(document.querySelector('.pencil-controls input[aria-label="Stroke width"]')).not.toBeNull()
    const initialCap = editor.state.pencil.cap
    await act(async () => { interfacePreference.set({ uiMode: 'sketch' }) })
    expect(capButton(labels.butt)).toBeNull()
    expect(editor.state.pencil.cap).toBe(initialCap)
    await act(async () => { interfacePreference.set({ uiMode: 'figma', locale: 'zh-CN' }) })
    expect(capButton('无端点')).not.toBeNull()
    expect(capButton('端点方形')).not.toBeNull()
    expect(capButton('端点圆形')!.getAttribute('aria-checked')).toBe('true')
    await act(async () => { interfacePreference.set({ locale: 'en' }) })
    await act(async () => { await dispatchEditorCommand(editor, 'set-tool-brush') })
    expect(capButton(labels.butt)).toBeNull()
    expect(editor.state.pencil.cap).toBe(initialCap)
    await act(async () => { await dispatchEditorCommand(editor, 'set-tool-pencil') })

    await choose('butt')
    await act(async () => pointer('pointerdown', 20, 40))
    await act(async () => { editor.set({ pencil: { ...editor.state.pencil, cap: 'square' } }) })
    for (let step = 1; step <= 12; step++) await act(async () => pointer('pointermove', 20 + step * 16, 40))
    await flushFrames()
    await act(async () => pointer('pointerup', 212, 40))
    const held = editor.state.doc.nodes[editor.state.selection[0]]
    expect(held.strokes[0].cap).toBe('butt')
    expect(editor.state.pencil.cap).toBe('square')
    expect(outlineCap(held)).toBe('butt')

    const drawn = new Map<PencilCap, string>()
    drawn.set('butt', held.id)
    for (const [cap, y] of [['square', 140], ['round', 240]] as const) {
      await choose(cap)
      const node = await draw(y)
      expect(node.strokes[0].cap).toBe(cap)
      expect(outlineCap(node)).toBe(cap)
      expect(rasterCap(engine, node, 'start')).toBe(cap)
      expect(rasterCap(engine, node, 'end')).toBe(cap)
      drawn.set(cap, node.id)
    }
    const frozen = {
      butt: JSON.stringify(editor.state.doc.nodes[drawn.get('butt')!]),
      square: JSON.stringify(editor.state.doc.nodes[drawn.get('square')!]),
    }
    await choose('square')
    expect(JSON.stringify(editor.state.doc.nodes[drawn.get('butt')!])).toBe(frozen.butt)
    expect(JSON.stringify(editor.state.doc.nodes[drawn.get('square')!])).toBe(frozen.square)
    expect(editor.state.doc.nodes[drawn.get('round')!].strokes[0].cap).toBe('round')

    await act(async () => { editor.select([drawn.get('butt')!]) })
    expect(capButton(labels.square)).toBeNull()
    const field = rail().querySelector<HTMLSelectElement>('select[aria-label="Cap"]')
    expect(field?.value).toBe('butt')
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(field, 'round')
      field!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(editor.state.doc.nodes[drawn.get('butt')!].strokes[0].cap).toBe('round')
    expect(editor.state.doc.nodes[drawn.get('square')!].strokes[0].cap).toBe('square')
    expect(editor.state.doc.nodes[drawn.get('round')!].strokes[0].cap).toBe('round')
    expect(editor.state.pencil.cap).toBe('square')
    const squareSnapshot = JSON.stringify(editor.state.doc.nodes[drawn.get('square')!])
    await act(async () => { editor.undo() })
    expect(editor.state.tool).toBe('select')
    expect(editor.state.doc.nodes[drawn.get('butt')!].strokes[0].cap).toBe('butt')
    expect(JSON.stringify(editor.state.doc.nodes[drawn.get('square')!])).toBe(squareSnapshot)
    expect(editor.state.pencil.cap).toBe('square')
    await act(async () => { editor.redo() })
    expect(editor.state.doc.nodes[drawn.get('butt')!].strokes[0].cap).toBe('round')
    expect(editor.state.doc.nodes[drawn.get('square')!].strokes[0].cap).toBe('square')
    await act(async () => { editor.undo() })
    expect(editor.state.doc.nodes[drawn.get('butt')!].strokes[0].cap).toBe('butt')

    await act(async () => { editor.select([]); await dispatchEditorCommand(editor, 'set-tool-pencil') })
    expect(capButton(labels.square)!.getAttribute('aria-checked')).toBe('true')
    expect(editor.state.doc.nodes[drawn.get('round')!].strokes[0].cap).toBe('round')
    const roundId = drawn.get('round')!
    await act(async () => { editor.undo() })
    expect(editor.state.doc.nodes[roundId]).toBeUndefined()
    expect(editor.state.doc.nodes[drawn.get('butt')!].strokes[0].cap).toBe('butt')
    expect(editor.state.doc.nodes[drawn.get('square')!].strokes[0].cap).toBe('square')
    expect(editor.state.pencil.cap).toBe('square')
    await act(async () => { editor.redo() })
    expect(editor.state.doc.nodes[roundId].strokes[0].cap).toBe('round')
    expect(outlineCap(editor.state.doc.nodes[roundId])).toBe('round')
    expect(errors).toEqual([])
  } finally {
    engine.free()
    await act(async () => root.unmount())
    editor.dispose()
    interfacePreference.reset()
    dom.window.close()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})
