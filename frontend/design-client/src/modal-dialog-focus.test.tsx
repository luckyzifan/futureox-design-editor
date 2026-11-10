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
  expect(preview?.getAttribute('aria-label')).toBe('交互原型预览')
  expect(preview?.contains(document.activeElement)).toBe(true)
  expect(background.closest('[inert]')).toBeTruthy()
  press(document.activeElement!, 'Escape')
  expect(closed).toBe(true)
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(trigger)
  expect(background.hasAttribute('inert')).toBe(false)
})
