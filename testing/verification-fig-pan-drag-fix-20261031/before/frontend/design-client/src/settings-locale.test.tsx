// Mounted React/jsdom and real Editor/WASM; desktop IPC is a local test double.
// No browser/Electron pixel layout, physical persistence or GPU acceptance claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useState, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, uid } from './model'
import { SettingsDialog } from './SettingsDialog'
import { ViewControls } from './ViewControls'
import { useAdaptivePanels } from './AdaptivePanels'
import { createInterfacePreference, DEFAULT_INTERFACE_PREFERENCES, INTERFACE_PREFERENCE_KEY, interfacePreference, interfaceText } from './interface-preference'
import { nudgePreference } from './nudge-preference'
import { pageMemoryPreference } from './page-memory-preference'
import { settingsPreference } from './settings-preference'
import { shortcutPreference } from './shortcut-preference'
import { hasPendingEdits, registerPendingEdit } from './pending-edits'
import { canvasActions, CanvasAction } from './canvas-action-diagnostics'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge } from './desktop'

let dom: any, root: Root, mount: HTMLElement, editor: Editor
const cleanups: (() => void)[] = []
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html lang="original"><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'StorageEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(window as any).coreDesktop = { renderDiagnostics: true, renderDiagnosticsDetail: true }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 17)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  interfacePreference.reset(); nudgePreference.reset(); pageMemoryPreference.reset(); settingsPreference.reset(); shortcutPreference.set('figma-like')
  const doc = blank('Untouched 用户名称'), shape = node('rectangle', 20, 30, 100, 80)
  const second = { ...doc.pages[0], id: uid(), name: 'Authored 页面', children: [shape.id] }
  shape.name = 'Authored layer 名称'; doc.pages.push(second); doc.nodes[shape.id] = shape
  editor = new Editor(doc); editor.switchPage(second.id); editor.select([shape.id])
  mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); cleanups.splice(0).forEach(stop => stop()); editor.dispose()
  vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals()
})
function Harness({ desktop = false }: { desktop?: boolean }) {
  const panels = useAdaptivePanels(), [open, setOpen] = useState(true)
  useSyncExternalStore(editor.subscribe, editor.snapshot)
  return <div className="editor-shell" style={panels.style}><button onClick={() => setOpen(true)}>Reopen</button>
    <input data-authored-draft defaultValue="not committed: 12." />
    <ViewControls editor={editor} size={{ width: 1200, height: 800 }} fit={() => {}} />
    {open && <SettingsDialog editor={editor} desktop={desktop} onClose={() => setOpen(false)} />}</div>
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (text: string) => [...dialog().querySelectorAll('button')].find(button => button.textContent === text)!
const language = () => dialog().querySelector<HTMLSelectElement>('.interface-settings select')!
const change = async (select: HTMLSelectElement, value: string) => { await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) }) }
const click = async (text: string) => { await act(async () => button(text).click()) }

function desktopFixture() {
  const ok = { status: 'ok' } as const, cancelled = { status: 'cancelled' } as const
  const bridge = {
    version: 1, renderPolicy: Object.freeze({ cpuOnly: true }),
    listCatalog: vi.fn().mockResolvedValue({ ...ok, projects: [], directories: [], files: [] }),
    selectCatalogDirectory: vi.fn().mockResolvedValue(cancelled), scanCatalogDirectory: vi.fn().mockResolvedValue({ ...ok, directoryId: 'fixture', files: [], truncated: false }),
    openCatalogFile: vi.fn().mockResolvedValue(cancelled), openDocument: vi.fn().mockResolvedValue(cancelled), acceptDocument: vi.fn().mockResolvedValue(ok),
    saveDocument: vi.fn().mockResolvedValue({ ...ok, handle: 'fixture:fd', displayName: 'authored.fd' }),
    readRecovery: vi.fn().mockResolvedValue(cancelled), acceptRecovery: vi.fn().mockResolvedValue(ok), writeRecovery: vi.fn().mockResolvedValue(ok), clearRecovery: vi.fn().mockResolvedValue(ok),
    setDirty: vi.fn().mockResolvedValue(undefined), onCommand: vi.fn().mockReturnValue(() => {}), onCloseRequested: vi.fn().mockReturnValue(() => {}), respondToClose: vi.fn().mockResolvedValue({ accepted: true }),
  } satisfies DesktopBridge
  const session = new DesktopSession(bridge, editor, async () => 'cancel')
  cleanups.push(() => session.dispose())
  return { session, bridge }
}

test.each([false, true])('mounted locale changes preserve authored/editor state, dirty edits and undo/redo, desktop=%s', async desktop => {
  const { session, bridge } = desktopFixture()
  await session.save(); expect(session.dirty).toBe(false)
  editor.update(editor.state.selection, { opacity: 0.4 }); editor.update(editor.state.selection, { opacity: 0.7 }); editor.undo()
  expect(session.dirty).toBe(true); expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(true)
  const snapshot = editor.state, generation = editor.sessionGeneration, documentBefore = JSON.stringify(editor.state.doc)
  const effectiveView = { x: 12, y: 45, zoom: 1.75 }; editor.setViewCoalesced(effectiveView)
  const edited = vi.fn(); cleanups.push(editor.subscribeEdits(edited))
  const writes = bridge.saveDocument.mock.calls.length
  const pending = vi.fn(() => false); cleanups.push(registerPendingEdit(editor, { dirty: () => true, commit: pending }))
  await act(async () => root.render(<Harness desktop={desktop} />))
  await click('画布辅助')
  const originalDialog = dialog(), originalLanguage = language(), draft = mount.querySelector<HTMLInputElement>('[data-authored-draft]')!, canvasPanel = dialog().querySelector('[id$="-panel-canvas"]')!
  for (const locale of ['en', 'zh-CN', 'en', 'zh-CN', 'en'] as const) {
    await change(originalLanguage, locale)
    const text = interfaceText[locale]
    expect(dialog()).toBe(originalDialog); expect(language()).toBe(originalLanguage); expect(canvasPanel.hasAttribute('hidden')).toBe(false)
    expect(dialog().querySelector('h2')!.textContent).toBe(text.settingsTitle)
    expect(button(text.canvasTab).getAttribute('aria-selected')).toBe('true')
    expect(dialog().querySelector('.keyboard-profile-settings')!.getAttribute('aria-label')).toBe(text.keyboardSettings)
    expect(mount.querySelector('summary')!.getAttribute('aria-label')).toBe(text.zoomView)
    expect(mount.querySelector<HTMLInputElement>('.number input')?.getAttribute('aria-label') || mount.querySelector('[role="spinbutton"]')!.getAttribute('aria-label')).toBe(text.zoomRatio)
    expect(document.documentElement.lang).toBe(locale)
    expect(createInterfacePreference(() => localStorage).getSnapshot().locale).toBe(locale)
    expect(editor.state).toBe(snapshot); expect(editor.sessionGeneration).toBe(generation); expect(editor.effectiveView()).toBe(effectiveView)
    expect(JSON.stringify(editor.state.doc)).toBe(documentBefore); expect(session.dirty).toBe(true)
    expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(true); expect(hasPendingEdits(editor)).toBe(true)
    expect(draft.value).toBe('not committed: 12.'); expect(mount.querySelector('[data-authored-draft]')).toBe(draft)
  }
  expect(edited).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled(); expect(bridge.saveDocument).toHaveBeenCalledTimes(writes)
  expect(canvasActions(editor).snapshot().rows.some(row => row.actionCode === CanvasAction.settings && row.commandCode === 342)).toBe(true)
  await click('Done'); expect(dialog()).toBeNull()
  await act(async () => mount.querySelector<HTMLButtonElement>('button')!.click())
  expect(dialog().querySelector('h2')!.textContent).toBe('Settings'); expect(language().value).toBe('en')
  await act(async () => editor.redo()); expect(editor.state.doc.nodes[editor.state.selection[0]].opacity).toBe(0.7)
  await act(async () => editor.undo()); expect(JSON.stringify(editor.state.doc)).toBe(documentBefore)
  await act(async () => root.render(null)); expect(document.documentElement.lang).toBe('original')
})

test('default Chinese and exact key parity; unsupported locale falls back without changing neighboring preferences', () => {
  const fresh = createInterfacePreference(() => ({ getItem: () => null, setItem() {} }))
  expect(fresh.getSnapshot()).toEqual(DEFAULT_INTERFACE_PREFERENCES)
  const invalid = createInterfacePreference(() => ({ getItem: () => JSON.stringify({ locale: 'de', leftWidth: 333, rememberViewport: true }), setItem() {} }))
  expect(invalid.getSnapshot()).toMatchObject({ locale: 'zh-CN', leftWidth: 333, rememberViewport: true })
  expect(Object.keys(interfaceText.en)).toEqual(Object.keys(interfaceText['zh-CN']))
  expect(Object.values(interfaceText.en).every(text => text.length > 0 && !/\p{Script=Han}/u.test(text))).toBe(true)
})

test('locale storage failure stays usable and honest, live storage sync does not echo or alter Editor', async () => {
  await act(async () => root.render(<Harness />)); await click('画布辅助')
  const snapshot = editor.state
  const write = vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota') })
  await change(language(), 'en')
  expect(dialog().textContent).toContain(interfaceText.en.temporary); expect(language().value).toBe('en'); expect(editor.state).toBe(snapshot)
  write.mockRestore()
  localStorage.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify({ ...interfacePreference.getSnapshot(), locale: 'zh-CN' }))
  const externalWrite = vi.spyOn(dom.window.Storage.prototype, 'setItem')
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: INTERFACE_PREFERENCE_KEY, storageArea: localStorage })))
  expect(dialog().querySelector('h2')!.textContent).toBe('设置'); expect(externalWrite).not.toHaveBeenCalled(); expect(editor.state).toBe(snapshot)
})

test('locale refreshes existing validation/status text without replacing pending nudge drafts or memory preference', async () => {
  await act(async () => root.render(<Harness />))
  const field = dialog().querySelector<HTMLInputElement>('.nudge-settings input')!
  await act(async () => { field.value = '0'; field.dispatchEvent(new Event('input', { bubbles: true })); })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(interfaceText['zh-CN'].nudgeError)
  await click('画布辅助')
  await change(dialog().querySelector<HTMLSelectElement>('[id$="-memory-tier"]')!, 'expanded')
  await change(language(), 'en')
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(interfaceText.en.nudgeError)
  expect(dialog().querySelector('.settings-status')!.textContent).toBe(interfaceText.en.cacheSaved)
  expect(field.value).toBe('0'); expect(dialog().querySelector('.nudge-settings input')).toBe(field)
  expect(nudgePreference.getSnapshot().small).toBe(1); expect(pageMemoryPreference.getSnapshot()).toBe('expanded')
  await click('Input'); expect(field.value).toBe('0')
  await click('Restore preference defaults')
  expect(language().value).toBe('zh-CN'); expect(dialog().querySelector('.settings-status')!.textContent).toBe(interfaceText['zh-CN'].defaultsRestored)
  expect(pageMemoryPreference.getSnapshot()).toBe('balanced')
})

test.each([false, true])('English settings retains accurate platform saving scope, diagnostics mount and busy guard, desktop=%s', async desktop => {
  await act(async () => root.render(<Harness desktop={desktop} />)); await click('画布辅助'); await change(language(), 'en'); await click('Saving and scope')
  expect(dialog().textContent).toContain(desktop ? interfaceText.en.savingDesktop : interfaceText.en.savingWeb)
  await click('Nomi companion'); expect(dialog().textContent).toContain(desktop ? interfaceText.en.companionUnavailable : interfaceText.en.companionDesktopOnly)
  await click('Error logs'); expect(button('Error logs').getAttribute('aria-selected')).toBe('true')
  await act(async () => root.render(<SettingsDialog editor={editor} busy onClose={() => { throw Error('must stay open') }} />))
  const close = dialog().querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!
  expect(close.disabled).toBe(true)
  await act(async () => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(dialog()).not.toBeNull()
})

test.each(['zh-CN', 'en'] as const)('localized view menu keeps zoom/fit/display actions and open menu identity, locale=%s', async locale => {
  const fit = vi.fn(), doc = editor.state.doc, version = editor.state.version
  await act(async () => root.render(<ViewControls editor={editor} size={{ width: 1200, height: 800 }} fit={fit} />))
  const menu = mount.querySelector<HTMLDetailsElement>('details')!; menu.open = true
  await act(async () => interfacePreference.set({ locale }))
  const text = interfaceText[locale]
  expect(mount.querySelector('details')).toBe(menu); expect(menu.open).toBe(true)
  await act(async () => mount.querySelector<HTMLButtonElement>(`button[title="${text.zoomIn}"]`)!.click())
  expect(editor.state.view.zoom).toBeGreaterThan(1)
  await act(async () => [...mount.querySelectorAll('button')].find(button => button.textContent?.includes(text.fitSelection))!.click())
  expect(fit).toHaveBeenLastCalledWith(true); expect(menu.open).toBe(false)
  await act(async () => [...mount.querySelectorAll('label')].find(label => label.textContent === text.snap)!.querySelector<HTMLInputElement>('input')!.click())
  expect(editor.state.snap).toBe(false)
  expect(editor.state.doc).toBe(doc); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
})
