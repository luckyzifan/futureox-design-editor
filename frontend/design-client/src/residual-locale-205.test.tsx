// Mounted product surfaces for issue #205 residual copy.
// jsdom + real Editor/WASM and the desktop session failure path.
// Not an Electron, macOS, Metal, or window-geometry result. Tab-bar width (#286) is out of scope.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { LocalHome } from './LocalHome'
import { Editor } from './engine'
import { blank, node } from './model'
import { createInterfacePreference, interfacePreference, INTERFACE_PREFERENCE_KEY, type InterfaceLocale, type UiMode } from './interface-preference'
import { PendingEditContext } from './pending-edit-context'
import { DesktopSession, type LeaveDecision } from './desktop-session'
import { operationStatusText } from './operation-status-messages'
import { canvasStatusLabel } from './canvas-status-label'
import { translateProfessional } from './professional-dialog-messages'
import type { DesktopBridge } from './desktop'
import type { HomeSource } from './local-home-source'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const footerExpression = 'translateProfessional(canvasStatusLabel(operationStatusText(s.message, s.messagePresentation, locale)), locale)'
const footerWired = appSource.includes(`{${footerExpression}}`)

let dom: JSDOM, root: Root, editor: Editor | undefined
const sessions: DesktopSession[] = []
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name as 'document'])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 960 })
  interfacePreference.reset()
  const mount = document.createElement('div')
  document.body.append(mount)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  sessions.splice(0).forEach(session => session.dispose())
  editor?.dispose()
  editor = undefined
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const textOf = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const labelOf = (selector: string) => document.querySelector(selector)?.getAttribute('aria-label') ?? ''

function homeSource(): HomeSource {
  return {
    kind: 'web-local',
    list: vi.fn(async () => [{ id: 'root-c', name: 'Root C', revision: 4, updatedAt: Date.parse('2026-11-10T00:00:00Z'), deleted: false }]),
    open: vi.fn(async () => false),
  }
}

async function showHome(source: HomeSource, currentName: string) {
  await act(async () => {
    root.render(<LocalHome source={source} ready currentName={currentName} onResume={() => {}} onNew={async () => false} onOpenFile={async () => 'pending'} onSettings={() => {}} />)
    await Promise.resolve()
  })
}

function rectangleDocument() {
  const doc = blank('未命名设计')
  doc.pages[0].name = '页面 1'
  const shape = node('rectangle', 12, 18, 80, 48)
  shape.name = 'Frame A'
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  return { doc, id: shape.id }
}

async function showInspector(uiMode: UiMode) {
  if (!editor) {
    const fixture = rectangleDocument()
    editor = new Editor(fixture.doc)
    editor.select([fixture.id])
  }
  await act(async () => {
    interfacePreference.set({ uiMode })
    root.render(<PendingEditContext.Provider value={editor!}><Inspector editor={editor!} /></PendingEditContext.Provider>)
  })
}

function sampleHome() {
  return {
    title: textOf('h1'),
    newDesign: textOf('.local-home-actions button:nth-of-type(1)'),
    openDesign: textOf('.local-home-actions button:nth-of-type(2)'),
    refresh: textOf('.local-home-filter > button'),
    settings: textOf('.local-home-sidebar nav button:nth-of-type(2)'),
    searchLabel: labelOf('input'),
    searchPlaceholder: document.querySelector('input')?.getAttribute('placeholder') ?? '',
    searchValue: (document.querySelector('input') as HTMLInputElement | null)?.value ?? '',
    homeLabel: labelOf('.local-home'),
    continueEditing: textOf('.local-home-content header button'),
    fileName: textOf('.local-home-file strong'),
    layout: document.querySelector('.local-home-files')?.className ?? '',
  }
}

function sampleInspector() {
  const repeat = document.querySelector('.repeat-panel')
  const componentHeading = [...document.querySelectorAll('section > h3')].find(element => ['组件', 'Component'].includes(element.textContent?.trim() || ''))
  const componentButton = componentHeading?.parentElement?.querySelector('button')
  const exportPanel = document.querySelector('.node-export-panel')
  return {
    repeatLabel: repeat?.getAttribute('aria-label') ?? '',
    repeatTitle: repeat?.querySelector('h4')?.textContent?.trim() ?? '',
    repeatAction: repeat?.querySelector('button')?.textContent?.trim() ?? '',
    componentTitle: componentHeading?.textContent?.trim() ?? '',
    componentAction: componentButton?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    exportLabel: exportPanel?.getAttribute('aria-label') ?? '',
    exportTitle: exportPanel?.querySelector('h3')?.textContent?.trim() ?? '',
    exportAction: exportPanel?.querySelector('button')?.getAttribute('aria-label') ?? '',
    position: [...document.querySelectorAll('h3')].find(element => ['位置', 'Position'].includes(element.textContent?.trim() || ''))?.textContent?.trim() ?? '',
    layout: [...document.querySelectorAll('h3')].find(element => ['布局', 'Layout'].includes(element.textContent?.trim() || ''))?.textContent?.trim() ?? '',
    fill: [...document.querySelectorAll('h3')].some(element => element.textContent?.trim() === '填充' || element.textContent?.trim() === 'Fill')
      ? ([...document.querySelectorAll('h3')].find(element => ['填充', 'Fill'].includes(element.textContent?.replace(/\s+/g, ' ').trim() || ''))?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      : '',
    nodeName: document.querySelector('.inspector')?.getAttribute('data-node-name') ?? '',
    ownerLabel: labelOf('.inspector'),
  }
}

const englishHome = {
  title: 'Recent designs', newDesign: 'New design', openDesign: 'Open design file', refresh: 'Refresh', settings: 'Settings',
  searchLabel: 'Search recent designs', searchPlaceholder: 'Search design names', homeLabel: 'Local design home',
}
const chineseHome = {
  title: '最近的设计', newDesign: '新建设计', openDesign: '打开设计文件', refresh: '刷新', settings: '设置',
  searchLabel: '搜索最近设计', searchPlaceholder: '搜索设计名称', homeLabel: '本机设计首页',
}
const englishInspector = {
  repeatLabel: 'Non-destructive repeat', repeatTitle: 'Repeat', repeatAction: 'Add repeat',
  componentTitle: 'Component', componentAction: '◇ Create component',
  exportLabel: 'Layer export', exportTitle: 'Export', exportAction: 'Add layer export setting',
  position: 'Position', layout: 'Layout', fill: 'Fill',
}
const chineseInspector = {
  repeatLabel: '非破坏性重复变换', repeatTitle: '重复变换', repeatAction: '添加重复变换',
  componentTitle: '组件', componentAction: '◇ 创建组件',
  exportLabel: '图层导出设置', exportTitle: '导出', exportAction: '添加图层导出设置',
  position: '位置', layout: '布局', fill: '填充',
}

function diff(actual: Record<string, string>, expected: Record<string, string>) {
  return Object.entries(expected).filter(([key, value]) => actual[key] !== value).map(([key, value]) => ({ key, actual: actual[key], expected: value }))
}

function productFooter(state: Editor['state'], locale: InterfaceLocale) {
  expect(footerWired, 'App footer must keep the tagged status expression').toBe(true)
  return new Function('s', 'locale', 'operationStatusText', 'canvasStatusLabel', 'translateProfessional', `return ${footerExpression}`)(
    state, locale, operationStatusText, canvasStatusLabel, translateProfessional,
  ) as string
}

test('English home and rectangle sections follow the locale while Chinese and authored names stay', async () => {
  const source = homeSource()
  const mismatches: { surface: string; key: string; actual: string; expected: string }[] = []
  interfacePreference.set({ locale: 'en' })
  await showHome(source, '未命名设计')
  const setInput = async (selector: string, value: string) => {
    await act(async () => {
      const field = document.querySelector<HTMLInputElement>(selector)!
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await setInput('input', 'Root')
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('Root')
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('Root')
  const clickLabel = async (label: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
    if (!button) return false
    await act(async () => button.click())
    return true
  }
  if (!(await clickLabel('List'))) mismatches.push({ surface: 'home-list-en', key: 'listControl', actual: 'missing', expected: 'List' })
  const englishList = sampleHome()
  if (!(await clickLabel('Grid'))) mismatches.push({ surface: 'home-grid-en', key: 'gridControl', actual: 'missing', expected: 'Grid' })
  const englishGrid = sampleHome()
  for (const [key, value] of Object.entries(englishHome)) {
    for (const hit of diff({ [key]: englishList[key as keyof typeof englishList] }, { [key]: value })) mismatches.push({ surface: 'home-list-en', ...hit })
    for (const hit of diff({ [key]: englishGrid[key as keyof typeof englishGrid] }, { [key]: value })) mismatches.push({ surface: 'home-grid-en', ...hit })
  }
  if (!englishList.layout.includes('list')) mismatches.push({ surface: 'home-list-en', key: 'layout', actual: englishList.layout, expected: 'list' })
  if (englishGrid.layout.includes('list')) mismatches.push({ surface: 'home-grid-en', key: 'layout', actual: englishGrid.layout, expected: 'grid' })
  expect(englishList.searchValue).toBe('Root')
  expect(englishGrid.searchValue).toBe('Root')
  expect(englishList.fileName).toBe('Root C')
  await setInput('input', 'zzz')
  const empty = textOf('.local-home-empty')
  if (empty !== 'No matching designs.') mismatches.push({ surface: 'home-empty-en', key: 'empty', actual: empty, expected: 'No matching designs.' })
  await setInput('input', 'Root')
  if (englishList.continueEditing !== 'Continue editing · 未命名设计') mismatches.push({ surface: 'home-list-en', key: 'continueEditing', actual: englishList.continueEditing, expected: 'Continue editing · 未命名设计' })
  expect(englishList.continueEditing).not.toContain('Untitled')
  const stored = localStorage.getItem(INTERFACE_PREFERENCE_KEY)
  const reloaded = createInterfacePreference(() => localStorage)
  expect(reloaded.getSnapshot().locale).toBe('en')
  expect(stored).toContain('"locale":"en"')

  await act(async () => { interfacePreference.set({ locale: 'zh-CN' }) })
  const chineseGrid = sampleHome()
  if (!(await clickLabel('列表显示'))) mismatches.push({ surface: 'home-list-zh', key: 'listControl', actual: 'missing', expected: '列表显示' })
  const chineseList = sampleHome()
  for (const [key, value] of Object.entries(chineseHome)) {
    for (const hit of diff({ [key]: chineseGrid[key as keyof typeof chineseGrid] }, { [key]: value })) mismatches.push({ surface: 'home-grid-zh', ...hit })
    for (const hit of diff({ [key]: chineseList[key as keyof typeof chineseList] }, { [key]: value })) mismatches.push({ surface: 'home-list-zh', ...hit })
  }
  expect(chineseList.searchValue).toBe('Root')
  expect(chineseList.fileName).toBe('Root C')
  expect(chineseList.continueEditing).toBe('继续编辑 · 未命名设计')
  expect(source.open).not.toHaveBeenCalled()

  const modes: UiMode[] = ['figma', 'sketch']
  const inspectorSamples: Record<string, ReturnType<typeof sampleInspector>> = {}
  for (const mode of modes) {
    await act(async () => { interfacePreference.set({ locale: 'en', uiMode: mode }) })
    await showInspector(mode)
    inspectorSamples[`${mode}-en`] = sampleInspector()
    await act(async () => { interfacePreference.set({ locale: 'zh-CN', uiMode: mode }) })
    inspectorSamples[`${mode}-zh`] = sampleInspector()
  }
  for (const mode of modes) {
    for (const hit of diff(inspectorSamples[`${mode}-en`], englishInspector)) mismatches.push({ surface: `${mode}-inspector-en`, ...hit })
    for (const hit of diff(inspectorSamples[`${mode}-zh`], chineseInspector)) mismatches.push({ surface: `${mode}-inspector-zh`, ...hit })
    expect(inspectorSamples[`${mode}-en`].nodeName).toBe('Frame A')
    expect(inspectorSamples[`${mode}-en`].ownerLabel).toBe('Properties for Frame A')
    expect(inspectorSamples[`${mode}-zh`].ownerLabel).toBe('Frame A 属性')
    expect(editor!.state.doc.nodes[editor!.state.selection[0]].name).toBe('Frame A')
    expect(editor!.state.doc.name).toBe('未命名设计')
    expect(editor!.state.doc.pages[0].name).toBe('页面 1')
  }
  const englishResidual = mismatches.filter(item => item.surface.endsWith('-en'))
  const chineseResidual = mismatches.filter(item => item.surface.endsWith('-zh'))
  console.log(`LOCALE_205_SURFACES ${JSON.stringify({ englishResidual: englishResidual.length, chineseResidual: chineseResidual.length, homeLayouts: ['grid', 'list'], inspectorModes: modes, windowGeometry: 'NOT_RUN', electron: 'NOT_RUN' })}`)
  expect(englishResidual, JSON.stringify(englishResidual)).toEqual([])
  expect(chineseResidual, JSON.stringify(chineseResidual)).toEqual([])

  await act(async () => { interfacePreference.set({ locale: 'en', uiMode: 'figma' }) })
  const before = editor!.state.doc
  const repeatButton = document.querySelector('.repeat-panel button') as HTMLButtonElement
  await act(async () => repeatButton.click())
  expect(repeatButton.isConnected).toBe(false)
  expect(textOf('.repeat-panel')).toContain('Count (including source)')
  expect(textOf('.repeat-panel')).not.toContain('总次数')
  expect(editor!.state.message).toBe('重复变换')
  expect(editor!.state.doc.nodes[editor!.state.selection[0]].name).toBe('Frame A')
  await act(async () => editor!.undo())
  expect(editor!.state.doc.nodes[editor!.state.selection[0]].repeat).toBeUndefined()
  const exportButton = document.querySelector('.node-export-panel button') as HTMLButtonElement
  await act(async () => exportButton.click())
  expect(document.querySelector('input[aria-label="Export scale 1"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Export format 1"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Export suffix 1"]')).not.toBeNull()
  expect(editor!.state.message).toBe('修改图层导出设置')
  await setInput('[aria-label="Export suffix 1"]', 'Frame A')
  await act(async () => { interfacePreference.set({ locale: 'zh-CN' }) })
  expect((document.querySelector('[aria-label="导出后缀 1"]') as HTMLInputElement).value).toBe('Frame A')
  expect(editor!.state.doc.nodes[editor!.state.selection[0]].exportSettings?.[0].suffix).toBe('')
  expect(editor!.state.doc).not.toBe(before)
  await act(async () => editor!.undo())
  expect(editor!.state.doc.nodes[editor!.state.selection[0]].exportSettings).toBeUndefined()
  expect(editor!.canUndo).toBe(false)
})

test('operation failure localizes only the product prefix and keeps the raw diagnostic', async () => {
  const initial = blank('未命名设计')
  editor = new Editor(initial)
  const ok = { status: 'ok' } as const
  const cancelled = { status: 'cancelled' } as const
  const bridge = {
    version: 1,
    renderPolicy: Object.freeze({ cpuOnly: true }),
    listCatalog: vi.fn<DesktopBridge['listCatalog']>().mockResolvedValue({ ...ok, projects: [], directories: [], files: [] }),
    selectCatalogDirectory: vi.fn<DesktopBridge['selectCatalogDirectory']>().mockResolvedValue(cancelled),
    scanCatalogDirectory: vi.fn<DesktopBridge['scanCatalogDirectory']>().mockResolvedValue({ ...ok, directoryId: 'directory', files: [], truncated: false }),
    openCatalogFile: vi.fn<DesktopBridge['openCatalogFile']>().mockResolvedValue(cancelled),
    openDocument: vi.fn<DesktopBridge['openDocument']>().mockResolvedValue(cancelled),
    acceptDocument: vi.fn<DesktopBridge['acceptDocument']>().mockResolvedValue(ok),
    saveDocument: vi.fn<DesktopBridge['saveDocument']>().mockResolvedValue({ ...ok, handle: 'opaque:1', displayName: 'design.fd' }),
    readRecovery: vi.fn<DesktopBridge['readRecovery']>().mockResolvedValue(cancelled),
    acceptRecovery: vi.fn<DesktopBridge['acceptRecovery']>().mockResolvedValue(ok),
    writeRecovery: vi.fn<DesktopBridge['writeRecovery']>().mockResolvedValue(ok),
    clearRecovery: vi.fn<DesktopBridge['clearRecovery']>().mockResolvedValue(ok),
    setDirty: vi.fn<DesktopBridge['setDirty']>().mockResolvedValue(undefined),
    onCommand: vi.fn<DesktopBridge['onCommand']>().mockReturnValue(() => {}),
    onCloseRequested: vi.fn<DesktopBridge['onCloseRequested']>().mockReturnValue(() => {}),
    respondToClose: vi.fn<DesktopBridge['respondToClose']>().mockResolvedValue({ accepted: true }),
  } satisfies DesktopBridge
  const confirm = vi.fn<(reason: string) => Promise<LeaveDecision>>().mockResolvedValue('discard')
  const session = new DesktopSession(bridge, editor, confirm)
  sessions.push(session)
  await session.start()
  const diagnostic = 'Choose a .fd file; 作者图层 Frame A <>&'
  bridge.openDocument.mockResolvedValue({ status: 'error', code: 'INVALID_PATH', message: diagnostic })
  const before = editor.state.doc
  expect(await session.open()).toBe(false)
  const raw = `操作失败，当前画布已保留：${diagnostic}`
  expect(editor.state.message).toBe(raw)
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.name).toBe('未命名设计')
  expect(editor.canUndo).toBe(false)
  expect(confirm).not.toHaveBeenCalled()
  interfacePreference.set({ locale: 'en' })
  const english = productFooter(editor.state, 'en')
  interfacePreference.set({ locale: 'zh-CN' })
  const chinese = productFooter(editor.state, 'zh-CN')
  console.log(`LOCALE_205_PREFIX ${JSON.stringify({ englishPrefix: english.startsWith('Operation failed; the current canvas was retained: '), chinesePrefix: chinese.startsWith('操作失败，当前画布已保留：'), diagnosticKept: english.endsWith(diagnostic) && chinese.endsWith(diagnostic), rawKept: editor.state.message === raw })}`)
  expect(english).toBe(`Operation failed; the current canvas was retained: ${diagnostic}`)
  expect(chinese).toBe(raw)
  expect(english).toContain('作者图层 Frame A <>&')
  expect(english).not.toContain('Author layer')
})

test('professional dialog catalog still translates known chrome and leaves author text', () => {
  expect(translateProfessional('历史版本', 'en')).toBe('Version history')
  expect(translateProfessional('色彩与 HDR', 'en')).toBe('Color and HDR')
  expect(translateProfessional('本机文档库', 'en')).toBe('Local design library')
  expect(translateProfessional('刷新', 'en')).toBe('Refresh')
  expect(translateProfessional('最近的设计', 'en')).toBe('Recent designs')
  expect(translateProfessional('作者保存', 'en')).toBe('作者保存')
  expect(translateProfessional('Root C', 'en')).toBe('Root C')
  expect(translateProfessional('Frame A', 'en')).toBe('Frame A')
  expect(translateProfessional('未命名设计', 'en')).toBe('未命名设计')
  expect(translateProfessional('历史版本', 'zh-CN')).toBe('历史版本')
  expect(translateProfessional('Choose a .fd file', 'en')).toBe('Choose a .fd file')
})
