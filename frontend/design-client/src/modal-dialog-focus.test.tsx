// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
import type { Editor } from './engine'

vi.mock('./document-history', () => ({
  createDocumentHistory: () => ({
    route: 'local',
    list: async () => ({ entries: [], hasMore: false }),
    load: async () => null,
    restore: async () => null,
  }),
}))

let dom: JSDOM
let root: Root
let trigger: HTMLButtonElement
let background: HTMLButtonElement

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    constructor(_url: unknown, _options?: unknown) {}
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  vi.stubGlobal('Worker', FakeWorker)
  dom.window.Worker = FakeWorker as unknown as typeof Worker
  dom.window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false },
  }) as unknown as MediaQueryList
  interfacePreference.set({ locale: 'en' })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  const mount = document.createElement('div')
  trigger = document.createElement('button')
  background = document.createElement('button')
  trigger.textContent = 'Open'
  background.textContent = 'Background'
  host.append(trigger, background, mount)
  document.body.append(host)
  trigger.focus()
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  interfacePreference.reset()
  vi.unstubAllGlobals()
  dom.window.close()
})

function press(target: Element, key: string, shiftKey = false) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
}

function enabledButtons(dialog: Element) {
  return [...dialog.querySelectorAll('button')].filter(button => !button.disabled)
}

test('the plugin panel takes focus, isolates the background, and restores the trigger', async () => {
  const { PluginPanel } = await import('./plugins/PluginPanel')
  const editor = {} as Editor
  let closed = false
  await act(async () => {
    root.render(<PluginPanel editor={editor} returnFocus={trigger} onClose={() => { closed = true }} />)
  })
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.getAttribute('aria-modal')).toBe('true')
  expect(dialog?.contains(document.activeElement)).toBe(true)
  expect(document.activeElement).not.toBe(document.body)
  expect(background.closest('[inert]')).toBeTruthy()
  const buttons = enabledButtons(dialog!)
  expect(buttons.length).toBeGreaterThan(1)
  buttons.at(-1)!.focus()
  press(buttons.at(-1)!, 'Tab')
  expect(document.activeElement).toBe(buttons[0])
  press(buttons[0], 'Tab', true)
  expect(document.activeElement).toBe(buttons.at(-1))
  expect(document.activeElement).not.toBe(background)
  press(document.activeElement!, 'Escape')
  expect(closed).toBe(true)
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)
  expect(background.hasAttribute('inert')).toBe(false)
})

test('history and prototype preview take initial focus and Escape closes them', async () => {
  const { DocumentHistoryDialog } = await import('./DocumentHistoryDialog')
  const { PrototypePlayer } = await import('./PrototypePlayer')
  let closed = false
  await act(async () => {
    root.render(<DocumentHistoryDialog documentId="doc" documentName="Untitled" unsaved={false} onLocalAdopt={() => true} onClose={() => { closed = true }} />)
  })
  const history = document.querySelector('[role="dialog"]')
  expect(history?.getAttribute('aria-modal')).toBe('true')
  expect(history?.contains(document.activeElement)).toBe(true)
  expect(background.closest('[inert]')).toBeTruthy()
  const historyButtons = enabledButtons(history!)
  historyButtons.at(-1)!.focus()
  press(historyButtons.at(-1)!, 'Tab')
  expect(document.activeElement).toBe(historyButtons[0])
  press(document.activeElement!, 'Escape')
  expect(closed).toBe(true)
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)

  const doc = blank('Preview')
  const frame = node('frame', 0, 0, 240, 160)
  doc.nodes[frame.id] = frame
  doc.pages[0].children.push(frame.id)
  closed = false
  trigger.focus()
  await act(async () => {
    root.render(<PrototypePlayer document={doc} onClose={() => { closed = true }} />)
  })
  const preview = document.querySelector('[role="dialog"]')
  expect(preview?.getAttribute('aria-modal')).toBe('true')
  expect(preview?.getAttribute('aria-label')).toBe('Prototype preview')
  expect(preview?.contains(document.activeElement)).toBe(true)
  expect(background.closest('[inert]')).toBeTruthy()
  press(document.activeElement!, 'Escape')
  expect(closed).toBe(true)
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)
  expect(background.hasAttribute('inert')).toBe(false)
})

test('the Sketch Inspector defers fractional distribution and restores focus on cancel or commit', async () => {
  const { Editor } = await import('./engine')
  const { AlignmentControls } = await import('./AlignmentControls')
  const { SketchDistributionDialog } = await import('./SketchDistributionDialog')
  interfacePreference.set({ uiMode: 'sketch', locale: 'en' })
  const d = blank(), layers = [0, 15, 31].map(x => node('rectangle', x, 0, 10, 10))
  d.nodes = Object.fromEntries(layers.map(layer => [layer.id, layer]))
  d.pages[0].children = layers.map(layer => layer.id)
  const editor = new Editor(d)
  editor.select(d.pages[0].children)
  const before = editor.state.doc
  try {
    await act(async () => root.render(<><AlignmentControls editor={editor} /><SketchDistributionDialog editor={editor} /></>))
    const open = [...document.querySelectorAll<HTMLButtonElement>('.alignment-controls button')]
      .find(button => /distribute.*horizontal|horizontal.*distribut/i.test(button.getAttribute('aria-label') || ''))!
    expect(open).toBeDefined()
    open.focus()
    await act(async () => open.click())
    let dialog = document.querySelector<HTMLElement>('[aria-label="Distribution placement"]')!
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.contains(document.activeElement)).toBe(true)
    expect(background.closest('[inert]')).toBeTruthy()
    expect(editor.state.doc).toBe(before)
    await act(async () => press(document.activeElement!, 'Escape'))
    expect(document.querySelector('[aria-label="Distribution placement"]')).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(editor.canUndo).toBe(false)
    await act(async () => open.click())
    dialog = document.querySelector<HTMLElement>('[aria-label="Distribution placement"]')!
    const uneven = enabledButtons(dialog).find(button => button.textContent === 'Distribute Unevenly')!
    await act(async () => uneven.click())
    expect(editor.state.doc.nodes[layers[1].id].transform[4]).toBe(16)
    expect(document.querySelector('[aria-label="Distribution placement"]')).toBeNull()
    await act(async () => editor.undo())
    expect(editor.state.doc).toEqual(before)
    expect(editor.canUndo).toBe(false)
  } finally {
    await act(async () => root.render(null))
    editor.dispose()
  }
})
