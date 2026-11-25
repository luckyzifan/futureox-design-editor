// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopBridge } from '../desktop'
import type { Editor } from '../engine'
import { interfacePreference } from '../interface-preference'
import { resetFigmaDevMode, setFigmaDevMode } from '../figma-dev-mode'
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
  resetFigmaDevMode()
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
    manifestText: JSON.stringify({ name: `N${index}`, id: `local.n${index}`, api: '1.0.0', main: 'code.js' }),
  }))
  expect(acceptedDeclaredPlugins(many)).toHaveLength(32)
  expect(acceptedDeclaredPlugins(many).some(plugin => JSON.stringify(plugin).includes('root'))).toBe(false)
  const onlyDev = JSON.stringify({ ...JSON.parse(manifestText), editorType: ['dev'] })
  expect(acceptedDeclaredPlugins([{ grant, manifestText: onlyDev }])).toEqual([])
  expect(acceptedDeclaredPlugins([{ grant, manifestText: onlyDev }], 'dev')).toHaveLength(1)
})

test('the live Dev toggle changes the plugin catalog and launches its inspection context', async () => {
  interfacePreference.set({ locale: 'en', uiMode: 'figma' })
  const dev = JSON.stringify({ ...JSON.parse(manifestText), name: 'Only Dev', editorType: ['dev'] })
  const opened: unknown[] = []
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText: dev }] }),
      read: async () => ({ status: 'ok' as const, files: { 'code.js': 'figma.showUI(figma.editorType + ":" + figma.mode)', 'ui.html': '' } }),
      closeUi: async () => ({ status: 'ok' as const }),
      openUi: async (request: unknown) => { opened.push(request); return { status: 'ok' as const } },
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
    },
  } as unknown as DesktopBridge
  const { Editor: EditorClass } = await import('../engine')
  const { blank } = await import('../model')
  const current = new EditorClass(blank('Dev plugin panel'))
  try {
    await act(async () => { root.render(<PluginPanel editor={current} desktop={desktop} onClose={() => {}} />) })
    expect(document.body.textContent).not.toContain('Only Dev')
    await act(async () => { setFigmaDevMode(true) })
    expect(document.body.textContent).toContain('Only Dev')
    const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run')
    await act(async () => {
      run!.click()
      await vi.waitFor(() => expect(opened[0]).toMatchObject({ html: 'dev:inspect' }))
    })
    await act(async () => { setFigmaDevMode(false) })
    expect(document.body.textContent).not.toContain('Only Dev')
  } finally { current.dispose() }
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
  expect(document.body.textContent).toContain('Local plugins')
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
  expect(document.body.textContent).toContain('本机插件')
  expect(calls).toEqual([{ grant, paths: ['code.js', 'ui.html'] }])
  expect(document.body.textContent).toContain('测试停止')
})

test('an empty catalog tells the desktop user to reopen the panel after adding a plugin', async () => {
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
  expect(document.body.textContent).toContain('No local plugins found. Add a plugin folder and reopen this panel.')
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Run')).toBe(false)
})

test('a plugin UI crosses the desktop bridge with only the contracted keys', async () => {
  // #202: the panel used to forward the full UI state, and the host's exact
  // record validation rejected the extra `visible` key, so no plugin window
  // ever opened. Visibility is decided client-side before the call.
  interfacePreference.set({ locale: 'en' })
  const opened: unknown[] = []
  const uiHtml = '<!doctype html><p>QA UI</p>'
  const code = "figma.showUI(__html__, { width: 320, height: 200, title: 'QA UI' }); figma.notify('QA ready')"
  const manifest = JSON.stringify({
    ...JSON.parse(manifestText),
    networkAccess: { allowedDomains: ['https://cdn.example.test'], devAllowedDomains: ['http://localhost:3000'] },
  })
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText: manifest }] }),
      read: async () => ({ status: 'ok' as const, files: { 'code.js': code, 'ui.html': uiHtml } }),
      openUi: async (request: unknown) => { opened.push(request); return { status: 'ok' as const } },
      closeUi: async () => ({ status: 'ok' as const }),
      postUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
      onLaunch: () => () => {},
    },
  } as unknown as DesktopBridge
  const { Editor: EditorClass } = await import('../engine')
  const { blank } = await import('../model')
  const current = new EditorClass(blank('Plugin panel'))
  try {
    await act(async () => {
      root.render(<PluginPanel editor={current} desktop={desktop} onClose={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run')
    expect(run).toBeTruthy()
    await act(async () => {
      run!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => { if (opened.length === 0) throw new Error('openUi was not called') })
    })
    expect(opened).toEqual([{ html: uiHtml, width: 320, height: 200, title: 'QA UI', allowedDomains: ['https://cdn.example.test'] }])
  } finally {
    current.dispose()
  }
})

test('a desktop folder loads named UI files before running the selected command', async () => {
  interfacePreference.set({ locale: 'en' })
  const manifest = JSON.stringify({
    ...JSON.parse(manifestText), ui: { import: 'import.html', export: 'export.html' },
    menu: [{ name: 'Import variables', command: 'import' }, { name: 'Export variables', command: 'export' }],
  })
  const files: Record<string, string> = {
    'code.js': 'figma.showUI(__uiFiles__[figma.command])',
    'import.html': '<p>Import</p>',
    'export.html': '<p>Export</p>',
  }
  const opened: unknown[] = []
  const reads: string[][] = []
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText: manifest }] }),
      read: async ({ paths }: { paths: string[] }) => {
        reads.push(paths)
        return { status: 'ok' as const, files: Object.fromEntries(paths.map(path => [path, files[path]])) }
      },
      openUi: async (request: unknown) => { opened.push(request); return { status: 'ok' as const } },
      closeUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
    },
  } as unknown as DesktopBridge
  const { Editor: EditorClass } = await import('../engine')
  const { blank } = await import('../model')
  const current = new EditorClass(blank('Named panels'))
  const button = (label: string) => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  try {
    await act(async () => { root.render(<PluginPanel editor={current} desktop={desktop} onClose={() => {}} />) })
    await act(async () => { button('Run')!.click() })
    expect(reads).toEqual([['code.js', 'import.html'], ['export.html']])
    expect(opened).toEqual([])
    await act(async () => {
      button('Export variables')!.click()
      await vi.waitFor(() => expect(opened).toHaveLength(1))
    })
    expect(opened[0]).toMatchObject({ html: '<p>Export</p>' })
  } finally {
    current.dispose()
  }
})

test('mounted plugin documentchange reports local authored nodes and their changed properties', async () => {
  interfacePreference.set({ locale: 'en' })
  const code = `
    figma.on('documentchange', function (event) {
      const changes = event.documentChanges.map(function (change) {
        return change.type + ':' + change.origin + ':' + (change.node.removed ? 'removed' : change.node.name) +
          (change.properties ? ':' + change.properties.join(',') : '')
      })
      figma.notify(changes.join('|'))
    })
  `
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, manifestText }] }),
      read: async () => ({ status: 'ok' as const, files: { 'code.js': code, 'ui.html': '' } }),
      closeUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
    },
  } as unknown as DesktopBridge
  const { Editor: EditorClass } = await import('../engine')
  const { blank, node } = await import('../model')
  const current = new EditorClass(blank('Document changes'))
  const status = () => document.querySelector('[role="status"]')?.textContent
  try {
    await act(async () => { root.render(<PluginPanel editor={current} desktop={desktop} onClose={() => {}} />) })
    const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run')
    await act(async () => { run!.click() })
    await vi.waitFor(() => expect(status()).toBe('Declared'))
    const frame = node('frame', 0, 0, 80, 80)
    const child = node('rectangle', 5, 8, 10, 10)
    frame.name = 'Initial'
    frame.children = [child.id]
    await act(async () => {
      current.change('Create a subtree', doc => {
        doc.nodes[frame.id] = frame
        doc.nodes[child.id] = child
        doc.pages[0].children.push(frame.id)
      })
    })
    expect(status()).toBe('CREATE:LOCAL:Initial')
    await act(async () => { current.change('Rename', doc => { doc.nodes[frame.id].name = 'Renamed' }) })
    expect(status()).toBe('PROPERTY_CHANGE:LOCAL:Renamed:name')
    await act(async () => {
      current.change('Delete subtree', doc => {
        delete doc.nodes[child.id]
        delete doc.nodes[frame.id]
        doc.pages[0].children = []
      })
    })
    expect(status()).toBe('DELETE:LOCAL:removed')
  } finally { current.dispose() }
})

test('a plugin that finishes itself with closePlugin restores the panel load entries', async () => {
  // #207: after the guest called closePlugin the panel kept running=true, so
  // every load entry stayed disabled until the user pressed Stop plugin.
  interfacePreference.set({ locale: 'en' })
  const code = "figma.clientStorage.setAsync('done', true).then(() => { figma.createRectangle().name = 'QA closed cleanly'; figma.closePlugin('QA done') })"
  const storageCalls: unknown[] = []
  const token = 'storage-lease'
  const desktop = {
    plugins: {
      list: async () => ({ status: 'ok' as const, plugins: [{ grant, name: 'QA', id: 'qa', displayName: 'QA', manifestText, root: '/tmp/qa' }] }),
      read: async () => ({ status: 'ok' as const, files: { 'code.js': code, 'ui.html': '<!doctype html><p></p>' } }),
      storage: {
        begin: async (request: unknown) => { storageCalls.push(request); return { status: 'ok' as const, token } },
        call: async (request: unknown) => { storageCalls.push(request); return { status: 'ok' as const, value: null } },
        end: async (request: unknown) => { storageCalls.push(request); return { status: 'ok' as const } },
      },
      openUi: async () => ({ status: 'ok' as const }),
      closeUi: async () => ({ status: 'ok' as const }),
      postUi: async () => ({ status: 'ok' as const }),
      onUiMessage: () => () => {},
      onUiClosed: () => () => {},
      onLaunch: () => () => {},
    },
  } as unknown as DesktopBridge
  const { Editor: EditorClass } = await import('../engine')
  const { blank } = await import('../model')
  const current = new EditorClass(blank('Plugin panel'))
  try {
    await act(async () => {
      root.render(<PluginPanel editor={current} desktop={desktop} onClose={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const run = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run')
    expect(run).toBeTruthy()
    await act(async () => {
      run!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.waitFor(() => {
        const sample = [...document.querySelectorAll('button')].find(button => button.textContent === 'Run sample plugin') as HTMLButtonElement
        if (!sample || sample.disabled) throw new Error('load entries still disabled')
      })
    })
    expect(Object.values(current.state.doc.nodes).some(node => node.name === 'QA closed cleanly')).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').toBe('')
    const stop = [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop plugin') as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(document.body.textContent).toContain('QA done')
    expect(storageCalls).toEqual([
      { source: { folderGrant: grant } },
      { token, operation: { kind: 'set', key: '0064006f006e0065', value: { kind: 'json', json: 'true' } } },
      { token },
    ])
  } finally {
    current.dispose()
  }
})
