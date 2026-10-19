import { afterEach, describe, expect, test, vi } from 'vitest'
import React from 'react'
import { DesktopCatalog } from './DesktopCatalog'
import type { DesktopBridge } from './desktop'

// Component-handler tests only: React elements and narrow metadata IPC. No browser/GPU.
function harness() {
  const slots: any[] = [], effects: { fn: () => any; index: number }[] = []
  let cursor = 0
  const hooks = {
    useState(init: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(init: any) { const i = cursor++; return slots[i] ??= { current: init } },
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++, old = slots[i]
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) {
        old?.cleanup?.(); slots[i] = { deps }; effects.push({ fn, index: i })
      }
    },
  }
  Object.assign(hooks, { useLayoutEffect: hooks.useEffect })
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return {
    render(fn: () => any) { cursor = 0; const old = internals.H; internals.H = hooks; try { return fn() } finally { internals.H = old } },
    effects() { for (const { fn, index } of effects.splice(0)) slots[index].cleanup = fn() },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()) },
  }
}
function find(tree: any, predicate: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
}
function textContent(tree: any): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (!tree || typeof tree !== 'object') return ''
  return [tree?.props?.children].flat(Infinity).map(textContent).join('')
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const turn = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const project = { id: 'project', name: 'Local project', updatedAt: 1 }
const directory = { id: 'directory', projectId: project.id, displayName: 'Designs', updatedAt: 1, requiresReselection: false, directoryHandle: 'opaque:root' }
const file = { id: 'file', directoryId: directory.id, relativePath: 'project.fd', size: 100, modifiedAt: 1, indexedAt: 1 }
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals() })
function fixture(reselection = false) {
  vi.stubGlobal('document', { activeElement: null })
  const bridge = {
    listCatalog: vi.fn<DesktopBridge['listCatalog']>().mockResolvedValue({ status: 'ok', projects: [project], directories: [{ ...directory, requiresReselection: reselection, directoryHandle: reselection ? undefined : directory.directoryHandle }], files: [file] }),
    selectCatalogDirectory: vi.fn<DesktopBridge['selectCatalogDirectory']>().mockResolvedValue({ status: 'ok', project, directory }),
    scanCatalogDirectory: vi.fn<DesktopBridge['scanCatalogDirectory']>().mockResolvedValue({ status: 'ok', directoryId: directory.id, files: [file], truncated: false }),
  }
  const onOpen = vi.fn(async () => true), onClose = vi.fn(), h = harness()
  const render = () => h.render(() => DesktopCatalog({ bridge: bridge as unknown as DesktopBridge, onOpen, onClose }))
  const button = (label: string) => find(render(), (value) => value.type === 'button' && textContent(value) === label)
  render(); h.effects(); cleanups.push(h.unmount)
  return { bridge, onOpen, onClose, h, render, button }
}

describe('local project catalog panel', () => {
  test('persisted rows require native reselection and cannot open files', async () => {
    const f = fixture(true); await turn()
    expect(f.button('project.fd').props.disabled).toBe(true)
    expect(f.button('扫描设计文件').props.disabled).toBe(true)
    expect(f.bridge.scanCatalogDirectory).not.toHaveBeenCalled()
    expect(f.onOpen).not.toHaveBeenCalled()
  })
  test('fresh scan enables only opaque-root guarded opening', async () => {
    const f = fixture(); await turn()
    expect(f.button('project.fd').props.disabled).toBe(true)
    f.button('扫描设计文件').props.onClick(); await turn()
    expect(f.bridge.scanCatalogDirectory).toHaveBeenCalledWith({ directoryHandle: 'opaque:root' })
    expect(f.button('project.fd').props.disabled).toBe(false)
    f.button('project.fd').props.onClick(); await turn()
    expect(f.onOpen).toHaveBeenCalledWith({ directoryHandle: 'opaque:root', fileId: 'file' })
    expect(f.onClose).toHaveBeenCalledOnce()
  })
  test('reselecting a directory refreshes metadata and scans its new grant', async () => {
    const f = fixture(true); await turn()
    f.button('选择 / 重新授权目录').props.onClick(); await turn()
    expect(f.bridge.selectCatalogDirectory).toHaveBeenCalledOnce()
    expect(f.bridge.scanCatalogDirectory).toHaveBeenCalledWith({ directoryHandle: directory.directoryHandle })
    expect(f.button('project.fd').props.disabled).toBe(false)
  })
  test('failed rescan disables opening and displays the native error', async () => {
    const f = fixture(); await turn()
    f.button('扫描设计文件').props.onClick(); await turn()
    f.bridge.scanCatalogDirectory.mockResolvedValueOnce({ status: 'error', code: 'INVALID_HANDLE', message: '目录授权已失效' })
    f.button('扫描设计文件').props.onClick(); await turn()
    expect(f.button('project.fd').props.disabled).toBe(true)
    expect(find(f.render(), (value) => value.props?.role === 'alert').props.children.join('')).toContain('INVALID_HANDLE')
  })
  test('cancelled document replacement keeps the catalog and existing canvas workflow', async () => {
    const f = fixture(); await turn(); f.onOpen.mockResolvedValueOnce(false)
    f.button('扫描设计文件').props.onClick(); await turn()
    f.button('project.fd').props.onClick(); await turn()
    expect(f.onClose).not.toHaveBeenCalled()
    expect(find(f.render(), (value) => value.props?.role === 'status').props.children).toContain('未完成打开')
  })
  test('duplicate clicks share a gate and late native selection after unmount cannot scan', async () => {
    const f = fixture(); await turn()
    const response = deferred<Awaited<ReturnType<DesktopBridge['selectCatalogDirectory']>>>()
    f.bridge.selectCatalogDirectory.mockReturnValueOnce(response.promise)
    const select = f.button('选择 / 重新授权目录')
    select.props.onClick(); select.props.onClick()
    expect(f.bridge.selectCatalogDirectory).toHaveBeenCalledOnce()
    f.h.unmount(); response.resolve({ status: 'ok', project, directory }); await turn()
    expect(f.bridge.scanCatalogDirectory).not.toHaveBeenCalled()
  })
})
