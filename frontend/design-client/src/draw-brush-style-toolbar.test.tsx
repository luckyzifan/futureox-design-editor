// Mounted Canvas brush chrome. jsdom + Editor/WASM. The GPU surface is replaced.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank } from './model'
import { interfacePreference } from './interface-preference'
import { dispatchEditorCommand } from './editor-commands'

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

let dom: JSDOM, root: Root, editor: Editor, errors: unknown[][], frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  frames = new Map()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 800 },
  })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  dom.window.HTMLElement.prototype.setPointerCapture = () => {}
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  interfacePreference.reset()
  editor = new Editor(blank())
  editor.set({ view: { x: 0, y: 0, zoom: 1 }, snap: false, snapPixels: false })
  const mount = document.createElement('div')
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

const host = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
function styleSelect() {
  return document.querySelector<HTMLSelectElement>('select[aria-label="笔触样式"], select[aria-label="Brush style"]')
}
async function show() {
  await act(async () => { root.render(<Canvas editor={editor} />); for (let i = 0; i < 8; i++) await Promise.resolve() })
  host().focus()
}
async function choose(value: '' | 'heist' | 'bubblegum') {
  const select = styleSelect()
  expect(select).not.toBeNull()
  const doc = editor.state.doc
  const undo = editor.canUndo
  await act(async () => {
    select!.value = value
    select!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(editor.state.brush.style ?? '').toBe(value)
  expect(editor.state.doc).toBe(doc)
  expect(editor.canUndo).toBe(undo)
}
function pointer(type: string, x: number, y: number, options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } })
  host().dispatchEvent(event)
}
async function flushFrames() {
  const pending = [...frames.entries()]
  frames.clear()
  for (const [, fn] of pending) await act(async () => { fn(16) })
}
async function draw(points: Array<[number, number]>, shift = false) {
  const [start, ...rest] = points
  await act(async () => pointer('pointerdown', start[0], start[1], { shiftKey: shift }))
  for (const [x, y] of rest.slice(0, -1)) await act(async () => pointer('pointermove', x, y, { shiftKey: shift }))
  await flushFrames()
  const end = rest.at(-1)!
  await act(async () => pointer('pointerup', end[0], end[1], { shiftKey: shift }))
}

test('Figma brush toolbar lists Stretch Heist and Scatter Bubblegum before drawing; Sketch and the pencil do not', async () => {
  await show()
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-brush') })
  const select = styleSelect()
  expect(select).not.toBeNull()
  expect([...select!.options].map(option => [option.value, option.text])).toEqual([
    ['', '基本'],
    ['heist', 'Heist'],
    ['bubblegum', 'Bubblegum'],
  ])
  expect([...select!.querySelectorAll('optgroup')].map(group => [group.label, [...group.querySelectorAll('option')].map(option => option.value)])).toEqual([
    ['Stretch 笔触', ['heist']],
    ['Scatter 笔触', ['bubblegum']],
  ])
  expect(select!.value).toBe('')
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(styleSelect()!.getAttribute('aria-label')).toBe('Brush style')
  expect([...styleSelect()!.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Stretch brushes', 'Scatter brushes'])
  await choose('heist')
  await act(async () => { interfacePreference.set({ uiMode: 'sketch', locale: 'zh-CN' }) })
  expect(styleSelect()).toBeNull()
  expect(document.querySelector('input[aria-label="笔宽"]')).not.toBeNull()
  expect(editor.state.brush.style).toBe('heist')
  await act(async () => { interfacePreference.set({ uiMode: 'figma' }) })
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-pencil') })
  expect(styleSelect()).toBeNull()
  expect(editor.state.brush.style).toBe('heist')
  expect(editor.canUndo).toBe(false)
})

test('pointer strokes use the style chosen before drawing, preview stays a centerline, and sampling keeps that style', async () => {
  await show()
  await act(async () => { await dispatchEditorCommand(editor, 'set-tool-brush') })
  await act(async () => editor.set({ brush: { ...editor.state.brush, color: '#aa0000', width: 8 } }))
  await draw([[120, 160], [180, 160], [260, 160]], true)
  const basicId = editor.state.selection[0]
  const basic = editor.state.doc.nodes[basicId]
  expect(basic.kind).toBe('vector')
  expect(basic.vectorBrush).toBeUndefined()
  expect(basic.strokes[0].paint.color).toBe('#aa0000')
  expect(basic.strokes[0].width).toBe(8)
  expect(basic.network!.edges.length).toBeGreaterThan(0)

  await choose('heist')
  await act(async () => { interfacePreference.set({ uiMode: 'sketch' }) })
  await draw([[400, 80], [480, 80], [560, 90]], true)
  const sketchStroke = editor.state.doc.nodes[editor.state.selection[0]]
  expect(sketchStroke.vectorBrush).toBeUndefined()
  expect(sketchStroke.network!.edges.length).toBeGreaterThan(0)
  expect(editor.state.brush.style).toBe('heist')
  await act(async () => { interfacePreference.set({ uiMode: 'figma' }) })
  expect(styleSelect()!.value).toBe('heist')
  await act(async () => editor.set({ brush: { ...editor.state.brush, color: '#00aa00', width: 3 } }))
  expect(editor.state.brush.style).toBe('heist')
  const beforeSample = editor.state.doc
  await act(async () => pointer('pointerdown', 190, 160, { metaKey: true }))
  expect(editor.state.doc).toBe(beforeSample)
  expect(editor.state.message).toContain('已取样')
  expect(editor.state.brush).toMatchObject({ style: 'heist', color: '#aa0000', width: 8 })

  await draw([[80, 240], [140, 180], [210, 250], [280, 190]])
  const styledId = editor.state.selection[0]
  const styled = editor.state.doc.nodes[styledId]
  expect(styledId).not.toBe(basicId)
  expect(styled.vectorBrush).toMatchObject({ mode: 'stretch', width: 8 })
  expect(styled.name).toBe('Heist')
  expect(styled.fills[0].color).toBe('#aa0000')
  expect(styled.strokes[0].width).toBe(8)
  expect(styled.network!.edges.length).toBeGreaterThan(0)
  expect(editor.state.doc.nodes[basicId]).toEqual(basic)

  await choose('bubblegum')
  await draw([[80, 320], [150, 300], [230, 360]], true)
  const scatteredId = editor.state.selection[0]
  const scattered = editor.state.doc.nodes[scatteredId]
  expect(scattered.vectorBrush!.mode).toBe('scatter')
  expect(scattered.name).toBe('Bubblegum')
  expect(editor.state.doc.nodes[styledId].vectorBrush).toEqual(styled.vectorBrush)
  expect(scattered.network!.edges.length).toBeGreaterThan(0)

  await choose('')
  await draw([[40, 420], [110, 400], [190, 440]])
  const cleared = editor.state.doc.nodes[editor.state.selection[0]]
  expect(cleared.vectorBrush).toBeUndefined()
  expect(cleared.strokes[0].visible).toBe(true)
  expect(cleared.network!.edges.length).toBeGreaterThan(0)
  expect(editor.state.doc.nodes[scatteredId].vectorBrush!.mode).toBe('scatter')
  expect(editor.state.doc.nodes[styledId].vectorBrush!.mode).toBe('stretch')
})
