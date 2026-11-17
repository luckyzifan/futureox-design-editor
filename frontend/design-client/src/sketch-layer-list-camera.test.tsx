// jsdom replay of the layer-list camera. This does not run Electron, a GPU
// canvas, or native Sketch 2026.3.1. The follower applies the same reveal
// decision the canvas uses: consume requestReveal and pan with revealInView,
// leaving zoom unchanged. Sketch must not publish that request.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { revealInView } from './canvas-camera'
import { dispatchEditorCommand } from './editor-commands'
import { Editor } from './engine'
import { unionBounds } from './geometry'
import { applyInterfaceLayout } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { Layers } from './Layers'
import { blank, node } from './model'
import { shortcutPreference } from './shortcut-preference'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<html><body></body></html>')
  for (const key of ['window', 'document', 'navigator'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  return dom
})
bootstrap.window.close()

const SIZE = { width: 800, height: 600 }
let dom: JSDOM, root: Root, editor: Editor, stopReveal: () => void
let revealSpy: ReturnType<typeof vi.spyOn>

function offscreenDocument() {
  const doc = blank('图层列表')
  const left = node('rectangle', -2400, 120, 80, 40)
  left.name = '画布外左'
  const right = node('rectangle', 9200, 180, 80, 40)
  right.name = '画布外右'
  doc.nodes[left.id] = left
  doc.nodes[right.id] = right
  doc.pages[0].children = [left.id, right.id]
  return { doc, left, right }
}

function layerBounds(id: string) {
  const entry = editor.entries().find(item => item.id === id)
  expect(entry, id).toBeTruthy()
  return entry!.bounds
}

/** Mirrors the canvas reveal effect: a published request pans, and never rescales. */
function followLayerReveal(target: Editor) {
  return target.subscribeReveal(() => {
    const reveal = target.revealSnapshot()
    if (!reveal) return
    if (reveal.session !== target.sessionGeneration || reveal.documentId !== target.state.doc.id ||
      reveal.pageId !== target.state.page || !reveal.ids.some(id => target.state.selection.includes(id))) {
      target.consumeReveal(reveal.nonce)
      return
    }
    const ids = new Set(reveal.ids)
    const matched = target.entries().filter(entry => ids.has(entry.id))
    target.consumeReveal(reveal.nonce)
    target.flushPendingView()
    if (!matched.length) return
    const next = revealInView(target.state.view, unionBounds(matched.map(entry => entry.bounds)), SIZE)
    if (next) target.set({ view: next })
  })
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="layer-${id}"]`)
async function click(id: string, init: MouseEventInit = {}) {
  const target = row(id)
  expect(target, id).not.toBeNull()
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}
async function arrow(id: string, key: string, init: KeyboardEventInit = {}) {
  const target = row(id)
  expect(target, id).not.toBeNull()
  await act(async () => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}
const camera = () => ({ x: editor.state.view.x, y: editor.state.view.y, zoom: editor.state.view.zoom })

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'localStorage'] as const)
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  applyInterfaceLayout('sketch')
  const { doc } = offscreenDocument()
  editor = new Editor(doc)
  revealSpy = vi.spyOn(editor, 'requestReveal')
  stopReveal = followLayerReveal(editor)
  const canvas = document.createElement('div')
  canvas.tabIndex = 0
  canvas.dataset.testid = 'canvas'
  document.body.append(canvas)
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root.render(<Layers editor={editor} showPages={false} />) })
})
afterEach(async () => {
  stopReveal()
  await act(async () => root.unmount())
  revealSpy.mockRestore()
  editor.dispose()
  dom.window.close()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  vi.unstubAllGlobals()
})

test('Sketch layer-list click and arrow keys select without moving the viewport', async () => {
  expect(interfacePreference.getSnapshot().uiMode).toBe('sketch')
  const { left, right } = (() => {
    const ids = editor.state.doc.pages[0].children
    return { left: editor.state.doc.nodes[ids[0]], right: editor.state.doc.nodes[ids[1]] }
  })()
  const before = camera()
  const outside = revealInView(before, layerBounds(right.id), SIZE)
  expect(outside, 'the clicked layer has to sit outside the viewport').not.toBeNull()
  expect(outside!.zoom).toBe(before.zoom)
  expect(outside!.x !== before.x || outside!.y !== before.y).toBe(true)
  expect(revealInView(before, layerBounds(left.id), SIZE)).not.toBeNull()

  await act(async () => {
    editor.change('改名一', document => { document.nodes[left.id].name = '第一次' })
    editor.change('改名二', document => { document.nodes[left.id].name = '第二次' })
  })
  const version = editor.state.version
  const authored = editor.state.doc
  expect(editor.canUndo).toBe(true)

  const listed = Array.prototype.map.call(
    document.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    (item: HTMLElement) => item.dataset.layerId,
  ) as string[]
  expect(listed).toEqual([right.id, left.id])
  await click(listed[0])
  expect(editor.state.selection).toEqual([listed[0]])
  expect(row(listed[0])?.getAttribute('aria-selected')).toBe('true')
  expect(camera()).toEqual(before)
  expect(revealSpy).not.toHaveBeenCalled()
  expect(editor.state.doc).toBe(authored)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(true)

  await arrow(listed[0], 'ArrowDown')
  expect(editor.state.selection).toEqual([listed[1]])
  await arrow(listed[1], 'ArrowUp')
  expect(editor.state.selection).toEqual([listed[0]])
  await arrow(listed[0], 'ArrowDown', { shiftKey: true })
  expect(new Set(editor.state.selection)).toEqual(new Set(listed))

  await click(listed[1])
  expect(editor.state.selection).toEqual([listed[1]])
  await click(listed[0], { shiftKey: true })
  expect(new Set(editor.state.selection)).toEqual(new Set(listed))
  await click(listed[0], { metaKey: true })
  expect(editor.state.selection).toEqual([listed[1]])
  expect(camera()).toEqual(before)
  expect(editor.state.view.zoom).toBe(before.zoom)
  expect(revealSpy).not.toHaveBeenCalled()
  expect(editor.state.doc).toBe(authored)
  expect(editor.state.version).toBe(version)

  await act(async () => { editor.undo() })
  expect(editor.state.doc.nodes[left.id].name).toBe('第一次')
  expect(editor.canUndo).toBe(true)
  await act(async () => { editor.undo() })
  expect(editor.state.doc.nodes[left.id].name).toBe('画布外左')
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(true)
})

test('Sketch zoom-to-selection still reframes after a layer-list click', async () => {
  const right = editor.state.doc.nodes[editor.state.doc.pages[0].children[1]]
  const before = camera()
  await click(right.id)
  expect(editor.state.selection).toEqual([right.id])
  expect(camera()).toEqual(before)
  expect(revealSpy).not.toHaveBeenCalled()
  const undo = editor.canUndo
  const document = editor.state.doc
  await act(async () => { await dispatchEditorCommand(editor, 'zoom-selection') })
  expect(revealSpy).not.toHaveBeenCalled()
  expect(editor.state.selection).toEqual([right.id])
  expect(editor.state.doc).toBe(document)
  expect(editor.canUndo).toBe(undo)
  expect(camera()).not.toEqual(before)
  expect(editor.state.view.zoom).toBeGreaterThan(before.zoom)
  expect(revealInView(editor.state.view, layerBounds(right.id), SIZE)).toBeNull()
})

test('Figma layer-list clicks still pan the selection into view without rescaling', async () => {
  await act(async () => { applyInterfaceLayout('figma') })
  expect(interfacePreference.getSnapshot().uiMode).toBe('figma')
  const right = editor.state.doc.nodes[editor.state.doc.pages[0].children[1]]
  const before = camera()
  expect(revealInView(before, layerBounds(right.id), SIZE)).not.toBeNull()
  await click(right.id)
  expect(editor.state.selection).toEqual([right.id])
  expect(revealSpy).toHaveBeenCalledTimes(1)
  expect(editor.state.view.zoom).toBe(before.zoom)
  expect(editor.state.view.x !== before.x || editor.state.view.y !== before.y).toBe(true)
  expect(revealInView(editor.state.view, layerBounds(right.id), SIZE)).toBeNull()
  expect(editor.canUndo).toBe(false)
})

test('repeated Sketch layer-list clicks publish no reveal and leave the camera put', async () => {
  const [leftId, rightId] = editor.state.doc.pages[0].children
  const before = camera()
  await click(rightId)
  await click(leftId)
  revealSpy.mockClear()
  const rounds = 40
  for (let index = 0; index < rounds; index++) {
    await click(index % 2 === 0 ? rightId : leftId)
  }
  const reveals = revealSpy.mock.calls.length
  const moved = camera().x !== before.x || camera().y !== before.y || camera().zoom !== before.zoom
  expect(reveals).toBe(0)
  expect(moved).toBe(false)
  expect(camera()).toEqual(before)
  expect(editor.canUndo).toBe(false)

  await act(async () => { applyInterfaceLayout('figma') })
  revealSpy.mockClear()
  const figmaClicks = 20
  for (let index = 0; index < figmaClicks; index++) await click(index % 2 === 0 ? rightId : leftId)
  expect(revealSpy).toHaveBeenCalledTimes(figmaClicks)
  expect(editor.state.view.zoom).toBe(before.zoom)
  expect(editor.canUndo).toBe(false)
})
