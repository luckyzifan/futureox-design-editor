// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { zipSync, strToU8 } from 'fflate'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Editor } from '../engine'
import { interfacePreference } from '../interface-preference'
import { blank } from '../model'
import { PluginPanel } from './PluginPanel'

let root: Root
let dom: JSDOM
let editor: Editor
const editors: Editor[] = []

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'File']) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.set({ locale: 'en' })
  const { Editor: EditorClass } = await import('../engine')
  editor = new EditorClass(blank('Plugin panel'))
  editors.push(editor)
  const { createRoot } = await import('react-dom/client')
  const mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  for (const current of editors.splice(0)) current.dispose()
  interfacePreference.reset()
  vi.unstubAllGlobals()
  dom.window.close()
})

function pluginZip(manifest: Record<string, unknown>, code: string) {
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'code.js': strToU8(code) })
}

async function renderPanel() {
  await act(async () => { root.render(<PluginPanel editor={editor} onClose={() => {}} />) })
}

async function loadZip(bytes: Uint8Array) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="plugin-archive"]')
  expect(input).toBeTruthy()
  const copy = bytes.slice()
  const file = { name: 'plugin.zip', arrayBuffer: async () => copy.buffer }
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const menuManifest = {
  name: 'Two commands', id: 'local.two', api: '1.0.0', main: 'code.js', editorType: ['figma'],
  menu: [{ name: 'Parent', menu: [{ name: 'Create Alpha', command: 'alpha' }, { name: 'Create Beta', command: 'beta' }] }],
}

test('a multi-command archive waits for a choice and runs only the picked command', async () => {
  await renderPanel()
  const version = editor.state.version
  await loadZip(pluginZip(menuManifest, `
    const rect = figma.createRectangle()
    rect.name = 'command-' + figma.command
    figma.closePlugin()
  `))
  expect(editor.state.version).toBe(version)
  expect(Object.values(editor.state.doc.nodes).map(node => node.name)).not.toContain('command-alpha')
  expect(document.body.textContent).toContain('Choose a command')
  expect(document.body.textContent).toContain('Create Alpha')
  expect(document.body.textContent).toContain('Create Beta')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Parent')).toBe(false)
  const beta = [...document.querySelectorAll('button')].find(button => button.textContent === 'Create Beta')
  expect(beta).toBeTruthy()
  await act(async () => { beta!.click() })
  await act(async () => {
    await vi.waitFor(() => {
      expect(Object.values(editor.state.doc.nodes).map(node => node.name)).toContain('command-beta')
    }, { timeout: 20_000 })
  })
  expect(Object.values(editor.state.doc.nodes).map(node => node.name)).not.toContain('command-alpha')
})

test('the production panel forwards editor events and retires listeners on close and document switch', async () => {
  await renderPanel()
  await loadZip(pluginZip({
    name: 'Watch', id: 'local.watch', api: '1.0.0', main: 'code.js', editorType: ['figma'],
  }, `
    let log = ''
    function note(name) { log += name + '|'; figma.notify(log) }
    figma.on('selectionchange', function () { note('selectionchange') })
    figma.on('documentchange', function () { note('documentchange') })
    figma.on('currentpagechange', function () { note('currentpagechange') })
    figma.notify('QA ready')
    figma.createRectangle().name = 'from-plugin'
  `))
  await act(async () => {
    await vi.waitFor(() => {
      expect(Object.values(editor.state.doc.nodes).some(node => node.name === 'from-plugin')).toBe(true)
    }, { timeout: 20_000 })
  })
  expect(editor.state.message).not.toMatch(/selectionchange|documentchange|currentpagechange/)
  const created = Object.values(editor.state.doc.nodes).find(node => node.name === 'from-plugin')!
  await act(async () => { editor.set({ selection: [created.id] }) })
  expect(editor.state.message).toBe('selectionchange|')
  await act(async () => { editor.change('rename external', document => { document.nodes[created.id].name = 'QA external edit' }) })
  expect(editor.state.message).toBe('selectionchange|documentchange|')
  expect(editor.state.doc.nodes[created.id].name).toBe('QA external edit')
  await act(async () => { expect(editor.addPage()).toBe(true) })
  expect(editor.state.message).toContain('currentpagechange')
  expect(editor.state.message.startsWith('selectionchange|documentchange|')).toBe(true)

  const watched = editor
  await act(async () => { root.render(null) })
  watched.change('after close', document => { document.name = 'After close' })
  expect(watched.state.message).toContain('after close')
  expect(watched.state.message).not.toContain('documentchange')

  await act(async () => { root.render(<PluginPanel editor={watched} onClose={() => {}} />) })
  await loadZip(pluginZip({
    name: 'Watch again', id: 'local.watch.again', api: '1.0.0', main: 'code.js', editorType: ['figma'],
  }, `
    figma.on('documentchange', function () { figma.notify('QA documentchange delivered') })
    figma.notify('QA ready')
  `))
  await act(async () => {
    await vi.waitFor(() => expect(watched.state.message).toBe('QA ready'), { timeout: 20_000 })
  })
  expect(watched.load(blank('Other document'))).toBe(true)
  watched.change('after switch', document => { document.name = 'Switched' })
  expect(watched.state.message).toContain('after switch')
  expect(watched.state.message).not.toContain('QA documentchange delivered')
})

test('an async plugin rejection is shown and does not commit the queued rectangle', async () => {
  await renderPanel()
  const version = editor.state.version
  await loadZip(pluginZip({
    name: 'Async fail', id: 'local.async.fail', api: '1.0.0', main: 'code.js', editorType: ['figma'],
  }, `
    ;(async function () {
      const rect = figma.createRectangle()
      rect.name = 'QA before async rejection'
      throw new Error('QA controlled asynchronous failure')
    })()
  `))
  await act(async () => {
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('QA controlled asynchronous failure')
    }, { timeout: 20_000 })
  })
  expect(editor.state.version).toBe(version)
  expect(Object.values(editor.state.doc.nodes).map(node => node.name)).not.toContain('QA before async rejection')
  const sample = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run sample plugin')
  const stop = [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop plugin')
  expect(sample?.disabled).toBe(false)
  expect(stop?.disabled).toBe(true)
})
