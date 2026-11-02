// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopBridge } from '../desktop'
import type { Editor } from '../engine'
import { interfacePreference } from '../interface-preference'
import { acceptedDeclaredPlugins } from './catalog'
import { PluginPanel } from './PluginPanel'

const manifestText = JSON.stringify({
  name: 'Declared', id: 'local.declared', api: '1.0.0', main: 'code.js', ui: 'ui.html', editorType: ['figma'],
})
const grant = '00000000-0000-4000-8000-000000000001'
const editor = {} as Editor
let root: Root, mount: HTMLDivElement, dom: { window: Window & typeof globalThis }

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { createRoot } = await import('react-dom/client')
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  interfacePreference.reset()
  vi.unstubAllGlobals()
  dom.window.close()
})

test('declared plugin records keep the manifest identity and drop paths', () => {
  const accepted = acceptedDeclaredPlugins([
    { grant, name: 'Evil', id: 'evil', displayName: 'Evil', manifestText, root: '/tmp/secret-root' },
    { grant: 'not-a-grant', manifestText },
    { grant: '00000000-0000-4000-8000-000000000002', manifestText: '{"name":"Bad","id":"bad","api":"1","main":"../code.js"}' },
  ])
  expect(accepted).toEqual([{ grant, id: 'local.declared', name: 'Declared', displayName: 'Declared', manifestText }])
  const many = Array.from({ length: 40 }, (_, index) => ({
    grant: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    manifestText: JSON.stringify({ name: `N${index}`, id: `local.n${index}`, api: '1', main: 'code.js' }),
  }))
  expect(acceptedDeclaredPlugins(many)).toHaveLength(32)
  expect(acceptedDeclaredPlugins(many).some(plugin => JSON.stringify(plugin).includes('root'))).toBe(false)
})

test('plugin host lists startup plugins and runs only the declared files', async () => {
  interfacePreference.set({ locale: 'en' })
  const calls: unknown[] = []
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [
        { grant, name: 'Evil', id: 'evil', displayName: 'Evil', manifestText, root: '/tmp/secret-root' },
        { grant: '00000000-0000-4000-8000-000000000002', manifestText: '{"name":"Bad","id":"bad","api":"1","main":"../code.js"}' },
      ] }),
      read: async (value: unknown) => { calls.push(value); return { status: 'error' as const, code: 'PLUGIN_GRANT', message: 'stopped in test' } },
      closeUi: async () => ({ status: 'ok' as const }),
      pick: async () => ({ status: 'cancelled' as const }),
      openUi: async () => ({ status: 'ok' as const }),
      postUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
      onLaunch: () => () => {},
    },
  } as unknown as DesktopBridge
  await act(async () => {
    root.render(<PluginPanel editor={editor} desktop={desktop} onClose={() => {}} />)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(document.body.textContent).toContain('Declared')
  expect(document.body.textContent).toContain('Enabled at startup')
  expect(document.body.textContent).not.toContain('Evil')
  expect(document.body.textContent).not.toContain('Bad')
  expect(document.body.textContent).not.toContain('/tmp/secret-root')
  const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run')
  expect(run).toBeTruthy()
  await act(async () => {
    run!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(calls).toEqual([{ grant, paths: ['code.js', 'ui.html'] }])
  expect(document.body.textContent).toContain('stopped in test')
})

test('a startup menu launch runs that declared plugin', async () => {
  interfacePreference.set({ locale: 'zh-CN' })
  const calls: unknown[] = []
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText }] }),
      read: async (value: unknown) => { calls.push(value); return { status: 'error' as const, code: 'PLUGIN_GRANT', message: '测试停止' } },
      closeUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
      onLaunch: () => () => {},
    },
  } as unknown as DesktopBridge
  await act(async () => {
    root.render(<PluginPanel editor={editor} desktop={desktop} launch={{ grant, token: 1 }} onClose={() => {}} />)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(document.body.textContent).toContain('启动时已启用')
  expect(calls).toEqual([{ grant, paths: ['code.js', 'ui.html'] }])
  expect(document.body.textContent).toContain('测试停止')
})

test('an empty startup scan tells the desktop user to reopen after adding a plugin', async () => {
  interfacePreference.set({ locale: 'en' })
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [] }),
      closeUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
      onLaunch: () => () => {},
    },
  } as unknown as DesktopBridge
  await act(async () => {
    root.render(<PluginPanel editor={editor} desktop={desktop} onClose={() => {}} />)
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(document.body.textContent).toContain('No local plugins were enabled at startup')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Run')).toBe(false)
})
