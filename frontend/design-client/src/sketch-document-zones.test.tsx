// Issue #524. Sketch left bar: open documents, this document's pages, then layers.
// jsdom mounts the real Layers, PageList and WorkspaceTabs. editor.load timings
// use the desktop-dev kernel when SKETCH_ZONE_KERNEL=1. Plain rectangles do not
// claim a Mac GUI or native Sketch screenshot match.
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import type { DesktopSession, WorkspaceTab } from './desktop-session'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { initializeKernelModule, kernelModuleReady } from './kernel/module'
import { Layers } from './Layers'
import { blank, node, type DesignDocument } from './model'
import { WorkspaceTabs } from './WorkspaceTabs'

// Frozen from the main kernel run before this change (3000 plain rectangles,
// desktop-dev wasm, jsdom): mount median 54.65ms, page collapse 1.93ms,
// editor.load median 177.47ms. Slack covers that run's sample spread.
const MOUNT_SLACK_MS = 40
const COLLAPSE_SLACK_MS = 8
const LOAD_SLACK_MS = 40
const DOCUMENT_COLLAPSE_MAX_MS = 20
const LAYERS = 3000

let root: Root | undefined
beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollTo = () => {}
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver
  }
  if (process.env.SKETCH_ZONE_KERNEL !== '1') return
  const wasm = new Uint8Array(await readFile(join(process.cwd(), 'public/kernel/design_kernel_bg.wasm')))
  await initializeKernelModule(wasm)
  expect(kernelModuleReady()).toBe(true)
}, 120_000)
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  interfacePreference.reset()
})

function callsFor(tabs: WorkspaceTab[]) {
  const calls = { switch: [] as string[], close: [] as string[], replace: 0 }
  const session = {
    subscribeTabs() { return () => {} },
    tabsSnapshot: () => tabs,
    requestWorkspaceTab(id: string) { calls.switch.push(id); return Promise.resolve(true) },
    closeWorkspaceTab(id: string) { calls.close.push(id); return Promise.resolve(true) },
    replace() { calls.replace += 1; return Promise.resolve(true) },
  }
  return { session: session as unknown as DesktopSession, calls }
}

function fingerprint(editor: Editor) {
  return {
    id: editor.state.doc.id,
    name: editor.state.doc.name,
    page: editor.state.page,
    selection: [...editor.state.selection],
    version: editor.state.version,
    pages: editor.state.doc.pages.map(page => page.id),
    nodes: Object.keys(editor.state.doc.nodes).length,
  }
}

function pair() {
  const current = blank('117.sketch')
  const shape = node('rectangle', 8, 12, 80, 40)
  shape.name = '画板'
  const otherShape = node('rectangle', 120, 12, 40, 20)
  otherShape.name = '矩形'
  current.nodes = { [shape.id]: shape, [otherShape.id]: otherShape }
  current.pages[0].name = '页面 1'
  current.pages[0].children = [shape.id, otherShape.id]
  current.pages.push({ ...blank().pages[0], name: '页面 2', children: [] })
  const other = blank('test.sketch')
  const tabs: WorkspaceTab[] = [
    { id: current.id, name: current.name, persisted: true },
    { id: other.id, name: other.name, persisted: true },
    { id: 'unsaved-draft', name: '未保存', persisted: false },
  ]
  return { current, other, shape, tabs }
}

function LiveDocuments({ editor, session }: { editor: Editor; session: DesktopSession }) {
  const activeId = useSyncExternalStore(editor.subscribe, () => editor.state.doc.id)
  return <WorkspaceTabs session={session} activeId={activeId} placement="sidebar" />
}

async function renderIn(uiMode: 'figma' | 'sketch', node: ReactNode) {
  interfacePreference.set({ uiMode })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<div className="editor-shell" data-ui-mode={uiMode}>
      <header className="editor-header" />
      <main className="editor-workspace"><div className="adaptive-layers-shell">{node}</div></main>
    </div>)
  })
}

const docToggle = () => document.querySelector<HTMLButtonElement>('[data-sketch-documents] .pages-current')!
const pageToggle = () => document.querySelector<HTMLButtonElement>('.layers-pages .pages-current')!
const docList = () => document.querySelector<HTMLElement>('.sketch-document-list')!
const pageBody = () => document.querySelector<HTMLElement>('.layers-pages .page-list-body')!
const selectedName = () => document.querySelector('.sketch-document-switch[aria-selected="true"] .sketch-document-name')?.textContent

test('Sketch sidebar lists open documents above pages and layers', async () => {
  const { current, shape, tabs } = pair()
  const editor = new Editor(current)
  editor.select([shape.id])
  const { session, calls } = callsFor(tabs)
  const before = fingerprint(editor)
  await renderIn('sketch', <Layers editor={editor} documents={<WorkspaceTabs session={session} activeId={current.id} placement="sidebar" />} />)
  const documents = document.querySelector('[data-sketch-documents]')!
  const pages = document.querySelector('.layers-pages')!
  const tree = document.querySelector('[role="tree"]')!
  expect(documents.closest('.layers-panel')).toBe(document.querySelector('.layers-panel'))
  expect(documents.closest('header')).toBeNull()
  expect(document.querySelector('.editor-shell > [data-workspace-tabs]')).toBeNull()
  expect(documents.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(pages.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(documents.getAttribute('aria-label')).toBe('文档')
  expect(docToggle().getAttribute('aria-label')).toBe('隐藏文档列表')
  expect(docToggle().getAttribute('aria-expanded')).toBe('true')
  expect(docToggle().textContent).toContain('文档')
  expect([...document.querySelectorAll('.sketch-document-name')].map(item => item.textContent)).toEqual(['117.sketch', 'test.sketch', '未保存'])
  expect(selectedName()).toBe('117.sketch')
  expect(document.querySelector('[data-document-id="' + current.id + '"] .page-dot')).not.toBeNull()
  expect(pageToggle().getAttribute('aria-label')).toBe('收起页面')
  expect(pageBody().hidden).toBe(false)
  expect(tree.querySelector('[data-testid="layer-' + shape.id + '"]')?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector<HTMLButtonElement>('[data-document-id="unsaved-draft"] .sketch-document-switch')!.disabled).toBe(true)

  await act(async () => document.querySelector<HTMLButtonElement>('[data-document-id="' + tabs[1].id + '"] .sketch-document-switch')!.click())
  expect(calls.switch).toEqual([tabs[1].id])
  expect(fingerprint(editor)).toEqual(before)
  expect(selectedName()).toBe('117.sketch')

  await act(async () => document.querySelector<HTMLButtonElement>('[data-document-id="' + current.id + '"] .sketch-document-switch')!.click())
  expect(calls.switch).toEqual([tabs[1].id])
  expect(fingerprint(editor)).toEqual(before)

  await act(async () => docToggle().click())
  expect(docList().hidden).toBe(true)
  expect(docToggle().getAttribute('aria-label')).toBe('显示文档列表')
  expect(docToggle().getAttribute('aria-expanded')).toBe('false')
  expect(pageBody().hidden).toBe(false)
  expect(pageToggle().getAttribute('aria-label')).toBe('收起页面')
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(docList().textContent).toContain('117.sketch')
  expect(docList().textContent).toContain('test.sketch')
  expect(fingerprint(editor)).toEqual(before)
  expect(calls.switch).toEqual([tabs[1].id])
  expect(calls.close).toEqual([])
  expect(calls.replace).toBe(0)

  await act(async () => pageToggle().click())
  expect(pageBody().hidden).toBe(true)
  expect(docList().hidden).toBe(true)
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(fingerprint(editor)).toEqual(before)

  await act(async () => docToggle().click())
  expect(docList().hidden).toBe(false)
  expect(docToggle().getAttribute('aria-label')).toBe('隐藏文档列表')
  expect(pageBody().hidden).toBe(true)
  expect(selectedName()).toBe('117.sketch')
  expect(fingerprint(editor)).toEqual(before)

  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭文档 test.sketch"]')!.click())
  expect(calls.close).toEqual([tabs[1].id])
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="新建文档标签"]')!.click())
  expect(calls.replace).toBe(1)
  expect(fingerprint(editor)).toEqual(before)
  editor.dispose()
})

test('collapsing the document list keeps the following document selected', async () => {
  const { current, tabs } = pair()
  const editor = new Editor(current)
  const { session } = callsFor(tabs)
  function Host({ active }: { active: string }) {
    return <Layers editor={editor} documents={<WorkspaceTabs session={session} activeId={active} placement="sidebar" />} />
  }
  interfacePreference.set({ uiMode: 'sketch' })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Host active={current.id} />) })
  const before = fingerprint(editor)
  await act(async () => docToggle().click())
  expect(docList().hidden).toBe(true)
  await act(async () => { root!.render(<Host active={tabs[1].id} />) })
  expect(docList().hidden).toBe(true)
  expect(document.querySelector('[data-document-id="' + tabs[1].id + '"] .sketch-document-switch')!.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('[data-document-id="' + current.id + '"] .sketch-document-switch')!.getAttribute('aria-selected')).toBe('false')
  expect(pageBody().hidden).toBe(false)
  expect(fingerprint(editor)).toEqual(before)
  editor.dispose()
})

test('Figma keeps header tabs and does not gain a document list', async () => {
  const { current, tabs } = pair()
  const editor = new Editor(current)
  const bar = callsFor(tabs)
  const side = callsFor(tabs)
  interfacePreference.set({ uiMode: 'figma' })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<div className="editor-shell" data-ui-mode="figma">
      <header className="editor-header"><WorkspaceTabs session={bar.session} activeId={current.id} /></header>
      <main className="editor-workspace"><div className="adaptive-layers-shell">
        <Layers editor={editor} documents={<WorkspaceTabs session={side.session} activeId={current.id} placement="sidebar" />} />
      </div></main>
    </div>)
  })
  expect(document.querySelector('[data-sketch-documents]')).toBeNull()
  expect(document.querySelector('[aria-label="隐藏文档列表"]')).toBeNull()
  expect(document.querySelector('[aria-label="显示文档列表"]')).toBeNull()
  expect(document.querySelector('header nav[data-workspace-tabs] [role="tablist"]')).not.toBeNull()
  expect(document.querySelector('header [role="tab"][aria-selected="true"]')!.textContent).toBe('117.sketch')
  expect(document.querySelector('.layers-pages')).not.toBeNull()
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(document.querySelector('.layers-document-title')!.textContent).toContain('117.sketch')
  await act(async () => pageToggle().click())
  expect(pageBody().hidden).toBe(true)
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  expect(bar.calls.switch).toEqual([])
  editor.dispose()
})

test('Sketch without a workspace session and source pages stay free of the document zone', async () => {
  const { current, tabs } = pair()
  const editor = new Editor(current)
  const { session } = callsFor(tabs)
  await renderIn('sketch', <Layers editor={editor} />)
  expect(document.querySelector('[data-sketch-documents]')).toBeNull()
  expect(document.querySelector('.layers-pages')).not.toBeNull()
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  await renderIn('sketch', <Layers editor={editor} showPages={false} documents={<WorkspaceTabs session={session} activeId={current.id} placement="sidebar" />} />)
  expect(document.querySelector('[data-sketch-documents]')).toBeNull()
  expect(document.querySelector('.layers-pages')).toBeNull()
  editor.dispose()
})

test('English Sketch document controls use the native labels', async () => {
  const { current, tabs } = pair()
  const editor = new Editor(current)
  const { session } = callsFor(tabs)
  interfacePreference.set({ uiMode: 'sketch', locale: 'en' })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Layers editor={editor} documents={<WorkspaceTabs session={session} activeId={current.id} placement="sidebar" />} />)
  })
  expect(document.querySelector('[data-sketch-documents]')!.getAttribute('aria-label')).toBe('Documents')
  expect(docToggle().textContent).toContain('Documents')
  expect(docToggle().getAttribute('aria-label')).toBe('Hide document list')
  await act(async () => docToggle().click())
  expect(docToggle().getAttribute('aria-label')).toBe('Show document list')
  expect(pageToggle().getAttribute('aria-label')).toBe('Collapse pages')
  editor.dispose()
})

test('App places Sketch documents in the sidebar and leaves the Figma header rule', () => {
  const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')
  const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8')
  expect(app).toContain('workspaceDocumentChrome(')
  expect(app).toContain('placement="sidebar"')
  expect(app).toContain('documentChrome.sketchSidebarDocuments && desktopSession')
  expect(app).toContain('documentChrome.windowTabBar && desktopSession')
  expect(app).not.toContain("uiMode === 'figma' && !source && !!desktopSession?.supportsWorkspace")
  expect(css).toContain('.editor-shell[data-ui-mode="figma"] > .editor-header[data-inline-tabs] .workspace-tabs')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] .sketch-document-row:has([aria-selected="true"])')
  expect(css).toContain('.editor-shell[data-ui-mode="sketch"] > nav[data-workspace-tabs]')
})

function many(name: string, count: number) {
  const doc = blank(name)
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const shape = node('rectangle', (i % 40) * 6, Math.floor(i / 40) * 6, 4, 4)
    shape.name = `层 ${i}`
    doc.nodes[shape.id] = shape
    ids.push(shape.id)
  }
  doc.pages[0].children = ids
  return doc
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function sample(work: () => Promise<number>, warmup: number, count: number) {
  for (let i = 0; i < warmup; i++) await work()
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(await work())
  return values
}

test('document list does not slow the large-document sidebar, its collapse, or document load', async () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const first = many('117.sketch', LAYERS)
  const second = many('test.sketch', LAYERS)
  const editor = new Editor(first)
  editor.select([first.pages[0].children[0]])
  const { session } = callsFor([
    { id: first.id, name: first.name, persisted: true },
    { id: second.id, name: second.name, persisted: true },
  ])
  const mount = async (withDocuments: boolean) => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const started = performance.now()
    await act(async () => {
      root!.render(<Layers editor={editor} documents={withDocuments ? <LiveDocuments editor={editor} session={session} /> : undefined} />)
    })
    return performance.now() - started
  }
  const withoutMount = await sample(() => mount(false), 2, 5)
  const pageWithout = await sample(async () => {
    const started = performance.now()
    await act(async () => pageToggle().click())
    return performance.now() - started
  }, 1, 5)
  const withMount = await sample(() => mount(true), 2, 5)
  const rowsBefore = document.querySelectorAll('[role="treeitem"]').length
  const before = fingerprint(editor)
  const documentCollapse = await sample(async () => {
    const started = performance.now()
    await act(async () => docToggle().click())
    return performance.now() - started
  }, 1, 5)
  const rowsAfter = document.querySelectorAll('[role="treeitem"]').length
  expect(fingerprint(editor)).toEqual(before)
  expect(rowsBefore).toBeGreaterThan(0)
  expect(rowsBefore).toBeLessThan(80)
  expect(rowsAfter).toBe(rowsBefore)
  const pageWith = await sample(async () => {
    const started = performance.now()
    await act(async () => pageToggle().click())
    return performance.now() - started
  }, 1, 5)
  const load = async () => {
    const next = editor.state.doc.id === first.id ? second : first
    const started = performance.now()
    await act(async () => { expect(editor.load(next)).toBe(true) })
    return performance.now() - started
  }
  await mount(false)
  const loadWithout = process.env.SKETCH_ZONE_KERNEL === '1' ? await sample(load, 1, 5) : []
  await mount(true)
  const loadWith = process.env.SKETCH_ZONE_KERNEL === '1' ? await sample(load, 1, 5) : []
  const result = {
    layers: LAYERS,
    kernel: kernelModuleReady(),
    withoutMountMs: withoutMount.map(value => Number(value.toFixed(2))),
    withMountMs: withMount.map(value => Number(value.toFixed(2))),
    withoutMountMedianMs: Number(median(withoutMount).toFixed(2)),
    withMountMedianMs: Number(median(withMount).toFixed(2)),
    pageWithoutMedianMs: Number(median(pageWithout).toFixed(2)),
    pageWithMedianMs: Number(median(pageWith).toFixed(2)),
    documentCollapseMs: documentCollapse.map(value => Number(value.toFixed(2))),
    documentCollapseMedianMs: Number(median(documentCollapse).toFixed(2)),
    loadWithoutMedianMs: loadWithout.length ? Number(median(loadWithout).toFixed(2)) : null,
    loadWithMedianMs: loadWith.length ? Number(median(loadWith).toFixed(2)) : null,
    rowsBefore,
    rowsAfter,
  }
  writeFileSync('/tmp/sketch-zone-candidate.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  expect(result.withMountMedianMs - result.withoutMountMedianMs).toBeLessThanOrEqual(MOUNT_SLACK_MS)
  expect(result.pageWithMedianMs - result.pageWithoutMedianMs).toBeLessThanOrEqual(COLLAPSE_SLACK_MS)
  expect(result.documentCollapseMedianMs).toBeLessThanOrEqual(DOCUMENT_COLLAPSE_MAX_MS)
  if (process.env.SKETCH_ZONE_KERNEL === '1') {
    expect(loadWithout.length).toBe(5)
    expect(loadWith.length).toBe(5)
    expect(result.loadWithMedianMs! - result.loadWithoutMedianMs!).toBeLessThanOrEqual(LOAD_SLACK_MS)
  }
  editor.dispose()
})
