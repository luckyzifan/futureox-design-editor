// Real mounted Inspector + Editor/WASM. Counts are CPU reuse witnesses, not FPS.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { Editor } from './engine'
import { blank, node } from './model'

const reads = vi.hoisted(() => ({ units: 0 }))
vi.mock('./property-units', async original => {
  const actual = await original<typeof import('./property-units')>()
  return { ...actual, propertyUnits: (...args: Parameters<typeof actual.propertyUnits>) => {
    reads.units++; return actual.propertyUnits(...args)
  } }
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('camera and parent presentation renders reuse controls; inherited edits and undo refresh them', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const doc = blank(), parent = node('group'), child = node('rectangle', 5, 7, 30, 40)
  parent.transform = [2, 0, 0, 2, 0, 0]; parent.children = [child.id]
  doc.nodes = { [parent.id]: parent, [child.id]: child }; doc.pages[0].children = [parent.id]
  const editor = new Editor(doc); editor.select([child.id])
  const root = createRoot(document.getElementById('mount')!)
  const show = (camera: number) => root.render(<div data-camera={camera}><Inspector editor={editor} /></div>)
  const width = () => document.querySelector('[aria-label="W"]')?.getAttribute('aria-valuenow')
  try {
    await act(async () => show(0)); expect(width()).toBe('60')
    const before = editor.state.doc; reads.units = 0
    for (let i = 1; i <= 20; i++) await act(async () => {
      editor.set({ view: { x: i, y: -i, zoom: 1 + i / 10 } }); show(i)
    })
    expect(reads.units).toBe(0); expect(editor.state.doc).toBe(before); expect(width()).toBe('60')
    await act(async () => editor.updateProperties([parent.id], { transform: [3, 0, 0, 3, 0, 0] }))
    expect(reads.units).toBeGreaterThan(0); expect(width()).toBe('90')
    await act(async () => editor.undo()); expect(width()).toBe('60')
    await act(async () => editor.redo()); expect(width()).toBe('90')
  } finally {
    await act(async () => root.unmount()); editor.dispose(); dom.window.close()
  }
})
