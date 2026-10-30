import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { blank } from './model'
import { StartupPreview } from './StartupPreview'
import type { StartupPreview as Preview } from './startup-preview'
import { KernelSurface } from './kernel/Surface'

// Component ownership and passive-effect ordering only; no DOM, browser or GPU.
function harness() {
  const slots: any[] = [], effects: { fn: () => any; index: number; cleanup?: () => void }[] = []
  let cursor = 0
  const hooks = {
    useContext() { cursor++; return null },
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useMemo(fn: any) { cursor++; return fn() },
    useCallback(fn: any) { const i = cursor++; return slots[i] ??= fn },
    useSyncExternalStore(_: any, snapshot: () => any) { cursor++; return snapshot() },
    useLayoutEffect() { cursor++ },
    useEffect(fn: () => any, deps?: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) {
        slots[i] = { deps }; effects.push({ fn, index: i, cleanup: old?.cleanup })
      }
    },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    render(fn: () => any) {
      cursor = 0
      const previous = internals.H
      internals.H = hooks
      try { return fn() } finally { internals.H = previous }
    },
    effects(filter = (_: () => any) => true) {
      for (const { fn, index, cleanup } of effects.splice(0)) if (filter(fn)) {
        cleanup?.(); slots[index].cleanup = fn()
      }
    },
    unmount() { for (const value of slots) value?.cleanup?.() },
  }
}
function find(tree: any, type: unknown): any {
  if (!tree || typeof tree !== 'object') return
  if (tree.type === type) return tree
  for (const value of [tree.props?.children].flat(Infinity)) {
    const result = find(value, type)
    if (result) return result
  }
}
function preview(document = blank()): Preview {
  return { documentId: document.id, pageId: document.pages[0].id, revision: 3,
    view: { x: 0, y: 0, zoom: 1 }, width: 900, height: 650, background: 'transparent',
    image: new Blob(['test'], { type: 'image/webp' }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('untouched bootstrap may show saved pixels before restore without waiting for a renderer', () => {
  const editor = new Editor(blank()), h = harness(), saved = blank(), startupPreview = preview(saved)
  let tree = h.render(() => Canvas({ editor, startupPreview, loading: true }))
  expect(find(tree, StartupPreview)?.props.preview).toBe(startupPreview)
  editor.load(saved, true)
  tree = h.render(() => Canvas({ editor, startupPreview, loading: false }))
  expect(find(tree, StartupPreview)?.props.preview).toBe(startupPreview)
  const surface = find(tree, KernelSurface)
  surface.props.onPresentation({ ...surface.props, epoch: editor.sessionGeneration, pixelRatio: 1, managed: false })
  h.render(() => Canvas({ editor, startupPreview, loading: false }))
  h.effects(fn => String(fn).includes('setStartupConsumed'))
  tree = h.render(() => Canvas({ editor, startupPreview, loading: false }))
  expect(find(tree, StartupPreview)).toBeUndefined()
})

test.each(['edit', 'document', 'page', 'session'] as const)('loading cannot show saved pixels after bootstrap %s ownership changes', boundary => {
  const editor = new Editor(blank()), h = harness(), startupPreview = preview()
  h.render(() => Canvas({ editor, startupPreview, loading: true }))
  if (boundary === 'edit') editor.change('An early edit', document => { document.name = 'An early edit' })
  if (boundary === 'document') editor.load(blank('Another document'))
  if (boundary === 'page') editor.set({ page: 'another-page' })
  if (boundary === 'session') editor.load(structuredClone(editor.state.doc), true)
  const tree = h.render(() => Canvas({ editor, startupPreview, loading: true }))
  expect(find(tree, StartupPreview)).toBeUndefined()
})

test('restored preview ownership ends on a same-id document session replacement', () => {
  const saved = blank(), editor = new Editor(saved), h = harness(), startupPreview = preview(saved)
  let tree = h.render(() => Canvas({ editor, startupPreview, loading: false }))
  expect(find(tree, StartupPreview)).toBeDefined()
  editor.load(structuredClone(saved), true)
  tree = h.render(() => Canvas({ editor, startupPreview, loading: false }))
  expect(find(tree, StartupPreview)).toBeUndefined()
})

test('preview replacement cannot flash an old image before passive URL cleanup and creation', () => {
  const h = harness(), first = preview(), next = preview()
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:next')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const render = (value: Preview) => h.render(() => StartupPreview({ preview: value, view: value.view,
    loading: false, width: 900, height: 650 }))
  expect(find(render(first), 'img')).toBeUndefined()
  h.effects()
  expect(find(render(first), 'img')?.props.src).toBe('blob:first')
  expect(find(render(next), 'img')).toBeUndefined()
  h.effects()
  expect(revoke).toHaveBeenCalledWith('blob:first')
  expect(find(render(next), 'img')?.props.src).toBe('blob:next')
  expect(create).toHaveBeenCalledTimes(2)
  h.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:next')
})
