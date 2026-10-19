import { afterEach, describe, expect, test, vi } from 'vitest'
import React from 'react'
import { Editor } from './engine'
import App from './App'
import * as localStore from './local-store'
import { blank, node } from './model'
import { CanvasTextEditor, TextInput } from './TextEditor'
import { Canvas } from './Canvas'
import { initializePicking } from './kernel/picking'
import { KernelSurface } from './kernel/Surface'
import { worldToScreen } from './canvas-camera'
import { NumberField } from './fields'
import { DraftInput } from './DraftInput'
import { Inspector } from './Inspector'
import { DesignTools } from './DesignTools'
import { DesktopSession, type LeaveDecision } from './desktop-session'
import type { DesktopBridge } from './desktop'
import { cancelPendingOperations, commitPendingEdits, hasPendingEdits } from './pending-edits'

// Deterministic component-handler boundary tests, using actual React JSX and WASM.
// This is intentionally not a DOM/browser integration or Electron focus-sequencing test.
function harness(context: unknown = null) {
  const slots: any[] = [], effects: { fn: () => any; index: number }[] = []
  const layouts: { fn: () => any; index: number; cleanup?: () => void }[] = []
  let cursor = 0
  const hooks = {
    useContext() { cursor++; return context },
    useCallback(fn: (...args: any[]) => any) { const i = cursor++; return slots[i] ??= fn },
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: () => any) { cursor++; return fn() },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        slots[i] = { deps }; layouts.push({ fn, index: i, cleanup: old?.cleanup })
      }
    },
    useEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        old?.cleanup?.(); slots[i] = { deps }; effects.push({ fn, index: i })
      }
    },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    render(fn: () => any) {
      cursor = 0; const previous = internals.H; internals.H = hooks
      let tree: any
      try { tree = fn() } finally { internals.H = previous }
      // Layout commit precedes any manually selected passive effects.
      for (const { fn, index, cleanup } of layouts.splice(0)) { cleanup?.(); slots[index].cleanup = fn() }
      return tree
    },
    effects(filter = (_: () => any) => true) { for (const { fn, index } of effects.splice(0)) if (filter(fn)) slots[index].cleanup = fn() },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()) },
  }
}
function find(tree: any, predicate: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const value = find(child, predicate); if (value) return value }
}
function fixture() {
  const document = blank(), text = node('text'); text.text = 'Saved text'
  document.nodes[text.id] = text; document.pages[0].children = [text.id]
  const editor = new Editor(document), ok = { status: 'ok' } as const
  const bridge = {
    version: 1, renderPolicy: Object.freeze({ cpuOnly: true }),
    listCatalog: vi.fn(async () => ({ ...ok, projects: [], directories: [], files: [] })),
    selectCatalogDirectory: vi.fn(async () => ({ status: 'cancelled' as const })),
    scanCatalogDirectory: vi.fn(async () => ({ ...ok, directoryId: 'directory', files: [], truncated: false })),
    openCatalogFile: vi.fn(async () => ({ status: 'cancelled' as const })),
    openDocument: vi.fn(async () => ({ status: 'cancelled' as const })), acceptDocument: vi.fn(async () => ok), setDirty: vi.fn(async (_: boolean) => {}),
    readRecovery: vi.fn(async () => ({ status: 'cancelled' as const })),
    writeRecovery: vi.fn(async () => ok), clearRecovery: vi.fn(async () => ok),
    saveDocument: vi.fn(async (_: any) => ({ ...ok, handle: 'file', displayName: 'test.fd' })),
  } as unknown as DesktopBridge
  const confirm = vi.fn(async (): Promise<LeaveDecision> => 'cancel')
  const session = new DesktopSession(bridge, editor, confirm)
  return { editor, text, bridge, confirm, session }
}
function canvasInput(f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>, close = vi.fn()) {
  return h.render(() => CanvasTextEditor({ document: f.editor.state.doc, node: f.editor.state.doc.nodes[f.text.id], editor: f.editor, matrix: [1, 0, 0, 1, 0, 0], onClose: close, onPreview: vi.fn() }))
}
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('opening a distant local design centers its content without overriding later camera moves', () => {
  const editor = new Editor(blank()), h = harness()
  cleanups.push(h.unmount)
  h.render(() => Canvas({ editor }))
  const document = blank('Distant design'), rectangle = node('rectangle', 1112, 195, 320, 263)
  document.nodes[rectangle.id] = rectangle
  document.pages[0].children = [rectangle.id]
  expect(editor.load(document)).toBe(true)
  h.render(() => Canvas({ editor }))
  expect(editor.state.view.zoom).toBe(1)
  expect(worldToScreen(editor.state.view, { x: 1272, y: 326.5 })).toEqual({ x: 500, y: 400 })
  const moved = { x: -400, y: 75, zoom: 0.8 }
  editor.set({ view: moved })
  h.render(() => Canvas({ editor }))
  expect(editor.state.view).toEqual(moved)
})

describe('pending text transactions at native lifecycle boundaries', () => {
  for (const kind of ['canvas', 'inspector'] as const) {
    test(`${kind} draft is dirty before blur and native save includes it`, async () => {
      const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
      await f.session.start(); await f.session.save()
      const tree = kind === 'canvas' ? canvasInput(f, h) : h.render(() => TextInput({ node: f.editor.state.doc.nodes[f.text.id], editor: f.editor }))
      h.effects()
      const input = find(tree, (el) => el.type === 'textarea')
      input.props.onChange({ target: { value: 'Unblurred draft' }, currentTarget: { value: 'Unblurred draft' } })
      expect(f.session.dirty).toBe(true)
      expect(f.bridge.setDirty).toHaveBeenLastCalledWith(true)
      expect(await f.session.save()).toBe(true)
      expect(JSON.parse(vi.mocked(f.bridge.saveDocument).mock.calls.at(-1)![0].documentJson).nodes[f.text.id].text).toBe('Unblurred draft')
      h.unmount()
      expect(f.session.dirty).toBe(false)
    })
    test(`${kind} IME vetoes save, close and replacement, then composition can commit`, async () => {
      const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
      await f.session.start(); await f.session.save()
      const tree = kind === 'canvas' ? canvasInput(f, h) : h.render(() => TextInput({ node: f.editor.state.doc.nodes[f.text.id], editor: f.editor }))
      h.effects(); const input = find(tree, (el) => el.type === 'textarea')
      input.props.onCompositionStart()
      expect(await f.session.save()).toBe(false)
      expect(await f.session.requestClose()).toBe(false)
      expect(await f.session.replace(blank('Replacement'))).toBe(false)
      expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Saved text')
      expect(vi.mocked(f.bridge.saveDocument).mock.calls).toHaveLength(1)
      input.props.onCompositionEnd({ currentTarget: { value: '输入完成' } })
      expect(await f.session.save()).toBe(true)
      expect(f.editor.state.doc.nodes[f.text.id].text).toBe('输入完成')
    })
  }
  test('close commits draft before asking; cancel preserves the edit and window', async () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    await f.session.start(); await f.session.save()
    const tree = canvasInput(f, h); h.effects()
    find(tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Keep me' } })
    expect(await f.session.requestClose()).toBe(false)
    expect(f.confirm).toHaveBeenCalledWith('close')
    expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Keep me')
    expect(f.session.closeReady).toBe(false)
  })
  test('refreshed node props do not let stale rich-text draft overwrite an external change', () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    let tree = canvasInput(f, h); h.effects()
    find(tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'My draft' } })
    tree = canvasInput(f, h)
    f.editor.update([f.text.id], { text: 'External edit' }, 'external')
    tree = canvasInput(f, h)
    expect(commitPendingEdits(f.editor)).toBe(false)
    expect(f.editor.state.doc.nodes[f.text.id].text).toBe('External edit')
    expect(hasPendingEdits(f.editor)).toBe(true)
    expect(find(tree, (el) => el.type === 'textarea').props.value).toBe('My draft')
  })
  test('clean rich-text registration does not veto save after an external change', () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    canvasInput(f, h); h.effects()
    f.editor.update([f.text.id], { text: 'External edit' }, 'external')
    expect(commitPendingEdits(f.editor)).toBe(true)
  })
  test('same-ID reload cannot accept a previous session draft', () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    const tree = canvasInput(f, h); h.effects()
    f.editor.load(structuredClone(f.editor.state.doc))
    find(tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Old session draft' } })
    expect(commitPendingEdits(f.editor)).toBe(false)
    expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Saved text')
  })
  test('clean inspector rebases on external text; dirty inspector retains draft and vetoes conflict', () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    const render = () => h.render(() => TextInput({ node: f.editor.state.doc.nodes[f.text.id], editor: f.editor }))
    let tree = render(); tree.props.ref.current = { value: 'Saved text' }; h.effects()
    f.editor.update([f.text.id], { text: 'External clean' }, 'external'); tree = render(); h.effects()
    expect(tree.props.ref.current.value).toBe('External clean')
    tree.props.onChange({ currentTarget: { value: 'Retained draft' } })
    f.editor.update([f.text.id], { text: 'External conflict' }, 'external'); tree = render(); h.effects()
    expect(commitPendingEdits(f.editor)).toBe(false)
    expect(f.editor.state.doc.nodes[f.text.id].text).toBe('External conflict')
    expect(hasPendingEdits(f.editor)).toBe(true)
  })
})

describe('modal keyboard and asynchronous insertion ownership', () => {
  test('dialog button Delete cannot reach canvas; modal owns Escape and preserves Space activation', () => {
    const f = fixture(), h = harness(), modal = harness()
    const eventTarget = () => {
      const listeners: Record<string, Set<(event: any) => void>> = {}
      return { listeners,
        addEventListener: vi.fn((name: string, fn: (event: any) => void) => { (listeners[name] ??= new Set()).add(fn) }),
        removeEventListener: vi.fn((name: string, fn: (event: any) => void) => { listeners[name]?.delete(fn) }),
      }
    }
    const windowTarget = eventTarget(), { listeners } = windowTarget
    // Browser Canvas effects own document listeners too. Keep one document
    // identity through setup, focus changes, and teardown rather than replacing
    // it with an activeElement-only object partway through the test.
    const documentTarget = { ...eventTarget(), hidden: false, activeElement: null as unknown, querySelector: () => null }
    vi.stubGlobal('window', windowTarget)
    vi.stubGlobal('document', documentTarget)
    vi.stubGlobal('navigator', { platform: 'Linux' })
    let mounted = true
    const unmount = () => { if (mounted) { mounted = false; h.unmount(); modal.unmount() } }
    cleanups.push(unmount, () => f.session.dispose(), () => f.editor.dispose())
    f.editor.select([f.text.id]); h.render(() => Canvas({ editor: f.editor }))
    h.effects((fn) => String(fn).includes('addEventListener("keydown", down)') || String(fn).includes("addEventListener('keydown', down)"))
    for (const name of ['keydown', 'keyup', 'blur']) expect(listeners[name]?.size).toBe(1)
    for (const name of ['visibilitychange', 'focusin']) expect(documentTarget.listeners[name]?.size).toBe(1)
    const close = vi.fn(), tree = modal.render(() => DesignTools({ editor: f.editor, onClose: close }))
    const dialog = find(tree, (el) => el.props?.role === 'dialog')
    expect(dialog.props['aria-modal']).toBe('true')
    for (const key of ['Delete', 'd', 'ArrowRight', ' ']) {
      for (const listener of listeners.keydown) listener({ target: { closest: (selector: string) => selector.includes('dialog') ? dialog : null }, key, code: key === ' ' ? 'Space' : key, ctrlKey: key === 'd', preventDefault: vi.fn() })
    }
    expect(f.editor.state.doc.nodes[f.text.id]).toBeDefined()
    expect(f.editor.state.doc.pages[0].children).toHaveLength(1)
    const preventDefault = vi.fn(), stopPropagation = vi.fn()
    dialog.props.onKeyDown({ key: ' ', preventDefault, stopPropagation, nativeEvent: {} })
    expect(preventDefault).not.toHaveBeenCalled(); expect(stopPropagation).toHaveBeenCalled()
    dialog.props.onKeyDown({ key: 'Escape', preventDefault, stopPropagation, nativeEvent: {} })
    expect(close).toHaveBeenCalledOnce()
    const first = { hidden: false, getAttribute: () => null, focus: vi.fn() }, last = { hidden: false, getAttribute: () => null, focus: vi.fn() }
    documentTarget.activeElement = last
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault, stopPropagation, nativeEvent: {}, currentTarget: { querySelectorAll: () => [first, last] } })
    expect(first.focus).toHaveBeenCalledOnce()
    documentTarget.activeElement = first
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault, stopPropagation, nativeEvent: {}, currentTarget: { querySelectorAll: () => [first, last] } })
    expect(last.focus).toHaveBeenCalledOnce()
    expect(document).toBe(documentTarget)
    unmount()
    // These assertions fail if passive effect registration is skipped or its
    // cleanup is omitted; a no-op removeEventListener stub cannot satisfy them.
    for (const target of [windowTarget, documentTarget]) {
      for (const [name, fn] of target.addEventListener.mock.calls)
        expect(target.removeEventListener).toHaveBeenCalledWith(name, fn)
      expect(Object.values(target.listeners).every(registered => registered.size === 0)).toBe(true)
    }
  })
  for (const boundary of ['load', 'same-id', 'page', 'page-return', 'close', 'dispose', 'unmount', 'none'] as const) {
    test(`image decode completion respects ${boundary} ownership`, async () => {
      const editor = new Editor(blank()), h = harness()
      cleanups.push(h.unmount)
      let tree = h.render(() => Canvas({ editor }))
      h.effects((fn) => String(fn).includes('mounted.current') || String(fn).includes('initializePicking'))
      await initializePicking(); await settle()
      // This handler test starts after the renderer has published a same-session
      // frame. Otherwise the readiness guard would reject before decoding and
      // all asynchronous ownership cases would pass without exercising a race.
      const surface = find(tree, (el) => el.type === KernelSurface)
      surface.props.onPresentation({ ...surface.props, epoch: editor.sessionGeneration, pixelRatio: 1, managed: false })
      tree = h.render(() => Canvas({ editor }))
      tree.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0 }) }
      let finish!: () => void
      const decoded = new Promise<void>((resolve) => { finish = resolve })
      const decode = vi.fn(() => decoded)
      vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,AA=='; onload!: () => void; readAsDataURL() { this.onload() } })
      vi.stubGlobal('Image', class { naturalWidth = 100; naturalHeight = 100; width = 1; height = 1; decode = decode })
      const dropping = tree.props.onDrop({ preventDefault() {}, clientX: 50, clientY: 50, dataTransfer: { getData: () => '', files: [{ name: 'drop.png', type: 'image/png', size: 1 }] } })
      await settle()
      expect(decode).toHaveBeenCalledOnce()
      if (boundary === 'load') editor.load(blank('New'))
      if (boundary === 'same-id') editor.load(structuredClone(editor.state.doc))
      if (boundary === 'page') editor.set({ page: 'other-page' })
      if (boundary === 'page-return') { const page = editor.state.page; editor.set({ page: 'other-page' }); editor.set({ page }) }
      if (boundary === 'close') cancelPendingOperations(editor)
      if (boundary === 'dispose') editor.dispose()
      if (boundary === 'unmount') h.unmount()
      finish(); await dropping
      expect(Object.keys(editor.state.doc.nodes)).toHaveLength(boundary === 'none' ? 1 : 0)
      if (boundary === 'none') {
        const inserted = Object.values(editor.state.doc.nodes)[0]
        expect({ width: inserted.width, height: inserted.height }).toEqual({ width: 100, height: 100 })
      }
    })
  }
})


describe('deferred document field ownership', () => {
  for (const kind of ['number', 'text'] as const) {
    test(`${kind} commits before native save, vetoes invalid input and IME`, async () => {
      const f = fixture(), h = harness(f.editor); cleanups.push(() => f.session.dispose(), h.unmount)
      await f.session.start(); await f.session.save()
      const tree = h.render(() => kind === 'number'
        ? NumberField({ label: '宽度', value: 100, min: 1, onChange: (width) => f.editor.update([f.text.id], { width }) })
        : DraftInput({ value: 'Saved text', validate: (value) => value !== 'invalid', onCommit: (text) => f.editor.update([f.text.id], { text }) }))
      h.effects()
      const input = find(tree, (el) => el.type === 'input'), target = { value: kind === 'number' ? '220' : 'New text', setCustomValidity: vi.fn(), reportValidity: vi.fn() }
      input.props.ref.current = target
      input.props.onChange({ currentTarget: target })
      expect(f.session.dirty).toBe(true)
      expect(await f.session.save()).toBe(true)
      expect(f.editor.state.doc.nodes[f.text.id][kind === 'number' ? 'width' : 'text']).toBe(kind === 'number' ? 220 : 'New text')
      target.value = kind === 'number' ? '' : 'invalid'; input.props.onChange({ currentTarget: target })
      expect(await f.session.save()).toBe(false)
      expect(hasPendingEdits(f.editor)).toBe(true)
      input.props.onCompositionStart()
      expect(await f.session.requestClose()).toBe(false)
    })
  }
  test('transient number controls do not dirty the document registry', () => {
    const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
    const tree = h.render(() => NumberField({ label: '缩放', value: 100, onChange: vi.fn() })); h.effects()
    find(tree, (el) => el.type === 'input').props.onChange({ currentTarget: { value: '150', setCustomValidity() {} } })
    expect(hasPendingEdits(f.editor)).toBe(false)
  })
})


test('invalid or composing fields veto direct selection, page and load before unmount', () => {
  const f = fixture(), h = harness(f.editor); cleanups.push(() => f.session.dispose(), h.unmount)
  f.editor.select([f.text.id])
  const tree = h.render(() => DraftInput({ value: 'Saved text', validate: () => false, onCommit: vi.fn() })); h.effects()
  tree.props.onChange({ currentTarget: { value: 'Invalid draft', setCustomValidity() {} } })
  const original = f.editor.state.doc, page = f.editor.state.page, generation = f.editor.sessionGeneration
  f.editor.select([]); f.editor.set({ page: 'other-page' })
  expect(f.editor.load(blank('Replacement'))).toBe(false)
  expect(f.editor.state.selection).toEqual([f.text.id]); expect(f.editor.state.page).toBe(page)
  expect(f.editor.state.doc).toBe(original); expect(f.editor.sessionGeneration).toBe(generation)
  expect(hasPendingEdits(f.editor)).toBe(true)
  tree.props.onCompositionStart(); f.editor.select([])
  expect(f.editor.state.selection).toEqual([f.text.id])
})


const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
describe('browser startup and switching fences', () => {
  test('late startup recovery cannot replace an early edit; capture blocks pre-ready input', async () => {
    vi.stubGlobal('window', { innerWidth: 1440 })
    let resolve!: (record: localStore.LocalRecord | null) => void
    vi.spyOn(localStore, 'localOpen').mockImplementation(() => new Promise((done) => { resolve = done }))
    const h = harness(); let tree = h.render(() => App())
    const preventDefault = vi.fn(), stopPropagation = vi.fn()
    tree.props.onKeyDownCapture({ nativeEvent: { isComposing: false, keyCode: 0 }, target: { closest: () => true }, preventDefault, stopPropagation })
    expect(preventDefault).toHaveBeenCalled()
    h.effects((fn) => String(fn).includes('Promise.all'))
    find(tree, (el) => el.props?.['aria-label'] === '文档名称').props.onChange({ target: { value: 'Early edit' } })
    resolve({ document: blank('Recovered late'), revision: 1, updatedAt: Date.now() })
    await settle(); tree = h.render(() => App())
    expect(find(tree, (el) => el.props?.['aria-label'] === '文档名称').props.value).toBe('Early edit')
    h.unmount()
  })
  test('synchronous switching gate rejects repeated clicks and delayed open cannot overwrite newer edits', async () => {
    vi.stubGlobal('window', { innerWidth: 1440 })
    const open = vi.spyOn(localStore, 'localOpen').mockResolvedValue(null)
    vi.spyOn(localStore.SaveCoordinator.prototype, 'save').mockResolvedValue()
    vi.spyOn(localStore, 'localSave').mockImplementation(async (document) => ({ document, revision: 1, updatedAt: Date.now() }))
    vi.spyOn(localStore, 'localSelect').mockResolvedValue()
    const h = harness(); h.render(() => App()); h.effects((fn) => String(fn).includes('Promise.all')); await settle()
    let tree = h.render(() => App())
    find(tree, (el) => el.props?.className === 'brand').props.onClick(); tree = h.render(() => App())
    let resolve!: (record: localStore.LocalRecord | null) => void
    open.mockImplementation(() => new Promise((done) => { resolve = done }))
    const create = find(tree, (el) => el.type === 'button' && [el.props.children].flat().includes('新建设计'))
    create.props.onClick(); create.props.onClick(); await settle()
    expect(open).toHaveBeenCalledTimes(2) // one startup read, one accepted switch
    find(tree, (el) => el.props?.['aria-label'] === '文档名称').props.onChange({ target: { value: 'Edit while opening' } })
    resolve(null); await settle(); tree = h.render(() => App())
    expect(find(tree, (el) => el.props?.['aria-label'] === '文档名称').props.value).toBe('Edit while opening')
    h.unmount()
  })
})


test('one successful field commit followed by a veto stays dirty and never writes a partial native save', async () => {
  const f = fixture(), a = harness(f.editor), b = harness(f.editor)
  cleanups.push(() => f.session.dispose(), a.unmount, b.unmount)
  await f.session.start(); await f.session.save()
  const first = a.render(() => DraftInput({ value: 'Saved text', onCommit: (text) => f.editor.update([f.text.id], { text }) }))
  const second = b.render(() => DraftInput({ value: 'Original', validate: () => false, onCommit: vi.fn() }))
  a.effects(); b.effects()
  first.props.onChange({ currentTarget: { value: 'Committed first', setCustomValidity() {} } })
  second.props.onChange({ currentTarget: { value: 'Invalid second', setCustomValidity() {} } })
  expect(await f.session.save()).toBe(false)
  expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Committed first')
  expect(f.session.dirty).toBe(true); expect(hasPendingEdits(f.editor)).toBe(true)
  expect(f.bridge.saveDocument).toHaveBeenCalledTimes(1)
  expect(f.bridge.setDirty).toHaveBeenLastCalledWith(true)
})


test('inspector image decode does not apply to a reloaded same-ID document', async () => {
  const f = fixture(), inspector = harness(f.editor), paint = harness(f.editor)
  cleanups.push(() => f.session.dispose(), paint.unmount)
  f.editor.update([f.text.id], (node) => { node.fills[0].kind = 'image' })
  f.editor.select([f.text.id])
  const tree = inspector.render(() => Inspector({ editor: f.editor }))
  const element = find(tree, (el) => el.type?.name === 'PaintEditor')
  expect(element).toBeDefined()
  const paintTree = paint.render(() => element.type(element.props)); paint.effects()
  let finish!: () => void; const decoded = new Promise<void>((resolve) => { finish = resolve })
  vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,AA=='; onload!: () => void; readAsDataURL() { this.onload() } })
  vi.stubGlobal('Image', class { naturalWidth = 100; naturalHeight = 100; width = 1; height = 1; decode() { return decoded } })
  const importing = find(paintTree, (el) => el.type === 'input' && el.props.type === 'file').props.onChange({ target: { files: [{ name: 'image.png', type: 'image/png', size: 1 }] } })
  f.editor.load(structuredClone(f.editor.state.doc)); const before = f.editor.state.doc
  finish(); await importing
  expect(f.editor.state.doc).toBe(before)
})


test('clean input unmount during leave confirmation does not invalidate approved close', async () => {
  const f = fixture(), h = harness(); cleanups.push(() => f.session.dispose(), h.unmount)
  await f.session.start(); await f.session.save()
  const tree = canvasInput(f, h); h.effects()
  find(tree, (el) => el.type === 'textarea').props.onChange({ target: { value: 'Committed before close' } })
  f.confirm.mockImplementation(async () => { h.unmount(); return 'discard' })
  expect(await f.session.requestClose()).toBe(true)
  expect(f.session.closeReady).toBe(true)
})

test('native open does not accept a file handle when editor load vetoes', async () => {
  const f = fixture(); cleanups.push(() => f.session.dispose())
  await f.session.start(); await f.session.save(); const before = f.editor.state.doc
  vi.mocked(f.bridge.openDocument).mockResolvedValue({ status: 'ok', handle: 'new-file', displayName: 'Other.fd', documentJson: JSON.stringify(blank('Other')) })
  vi.spyOn(f.editor, 'load').mockReturnValue(false)
  expect(await f.session.open()).toBe(false)
  expect(f.bridge.acceptDocument).not.toHaveBeenCalled()
  expect(f.editor.state.doc).toBe(before); expect(f.session.status.displayName).toBe('test.fd')
})

test('document title IME participates in the same pending commit veto', () => {
  vi.stubGlobal('window', { innerWidth: 1440 })
  const h = harness(), tree = h.render(() => App()); cleanups.push(h.unmount)
  h.effects((fn) => String(fn).includes('registerPendingEdit'))
  const title = find(tree, (el) => el.props?.['aria-label'] === '文档名称')
  const editor = find(tree, (el) => el.type === Canvas).props.editor
  title.props.onCompositionStart()
  expect(hasPendingEdits(editor)).toBe(true); expect(commitPendingEdits(editor)).toBe(false)
  title.props.onCompositionEnd()
  expect(commitPendingEdits(editor)).toBe(true)
})


test('numeric draft survives external property update and vetoes stale commit', () => {
  const f = fixture(), h = harness(f.editor); cleanups.push(() => f.session.dispose(), h.unmount)
  const onChange = vi.fn(), render = (value: number) => h.render(() => NumberField({ label: 'W', value, onChange }))
  let tree = render(100); h.effects()
  find(tree, (el) => el.type === 'input').props.onChange({ currentTarget: { value: '150', setCustomValidity() {} } })
  tree = render(200); h.effects()
  expect(commitPendingEdits(f.editor)).toBe(false); expect(onChange).not.toHaveBeenCalled()
  expect(hasPendingEdits(f.editor)).toBe(true)
})


test('handler harness commits layout before passive hooks and retires layout ownership on replacement/unmount', () => {
  const h = harness(), order: string[] = []
  const render = (generation: number) => h.render(() => {
    React.useEffect(() => { order.push('passive'); return () => { order.push('passive cleanup') } }, [])
    React.useLayoutEffect(() => { order.push(`layout ${generation}`); return () => { order.push(`layout cleanup ${generation}`) } }, [generation])
    return null
  })
  render(1)
  expect(order).toEqual(['layout 1'])
  h.effects(); expect(order).toEqual(['layout 1', 'passive'])
  render(2)
  expect(order.slice(-2)).toEqual(['layout cleanup 1', 'layout 2'])
  h.unmount()
  expect(order.slice(-2)).toEqual(['passive cleanup', 'layout cleanup 2'])
})
