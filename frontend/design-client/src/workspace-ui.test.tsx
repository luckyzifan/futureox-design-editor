import { MultiStylePanel } from './MultiStylePanel'
import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { layerSelection } from './layer-selection'
import { commonValue, selectionMetric } from './selection-properties'
import { MixedNumberField } from './MixedNumberField'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { blank, node, paint } from './model'
import { Editor } from './engine'
import React from 'react'
import { Layers } from './Layers'
import { WorkspaceLibrary } from './WorkspaceLibrary'
import type { DesktopSession } from './desktop-session'

function find(tree: any, predicate: (value: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const match = find(child, predicate); if (match) return match }
}
function textContent(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (!React.isValidElement<{ children?: React.ReactNode }>(tree)) return ''
  return React.Children.toArray(tree.props.children).map(textContent).join('')
}
function fixture() {
  const doc = blank(), a = node('rectangle', 10, 20, 100, 80), b = node('rectangle', 150, 20, 240, 120)
  a.fills = [paint('#ff0000')]; b.fills = [paint('#0000ff')]
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editor.select([a.id, b.id])
  const panel = () => MultiSelectionInspector({ editor, nodes: editor.state.selection.map((id) => editor.state.doc.nodes[id]) })
  return { editor, ids: [a.id, b.id], panel }
}
let nextHarnessId = 0
function componentHarness() {
  const slots: any[] = []; let cursor = 0
  const instanceId = ++nextHarnessId
  const hooks = {
    useState(initial: any) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], (value: any) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
    useRef(initial: any) { const at = cursor++; return slots[at] ??= { current: initial } },
    useId() { const at = cursor++; if (!(at in slots)) slots[at] = `test-${instanceId}-${at}`; return slots[at] },
    useEffect() { cursor++ },
    useLayoutEffect() { cursor++ },
    useMemo(fn: () => any) { cursor++; return fn() },
    useSyncExternalStore(_subscribe: any, snapshot: () => any) { cursor++; return snapshot() },
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  return { render(fn: () => any) { cursor = 0; const old = internals.H; internals.H = hooks; try { return fn() } finally { internals.H = old } } }
}

test('document history loads older pages without hiding the current versions', async () => {
  const current = { id: 'local-document', name: '历史设计', revision: 1002, hash: 'hash', updatedAt: 1, deleted: false }
  const revision = (number: number) => ({ ...current, revision: number })
  const session = {
    listWorkspace: vi.fn(async () => ({ status: 'ok', documents: [current] })),
    listRevisions: vi.fn(async (_id: string, before?: number) => before === undefined
      ? { status: 'ok', revisions: [revision(1002), revision(1001)], hasMore: true, nextBeforeRevision: 1001 }
      : { status: 'ok', revisions: [revision(1000)], hasMore: false }),
  } as unknown as DesktopSession
  const harness = componentHarness(), render = () => harness.render(() => WorkspaceLibrary({ session, onClose() {} }))
  const button = (name: string) => find(render(), value => value.type === 'button' && textContent(value) === name)
  const headingId = find(render(), value => value.props?.role === 'dialog').props['aria-labelledby']
  expect(find(render(), value => value.type === 'h2').props.id).toBe(headingId)
  button('刷新').props.onClick()
  await vi.waitFor(() => expect(button('历史版本')).toBeDefined())
  button('历史版本').props.onClick()
  await vi.waitFor(() => expect(button('加载更早版本')).toBeDefined())
  button('加载更早版本').props.onClick()
  await vi.waitFor(() => expect(button('加载更早版本')).toBeUndefined())
  expect(session.listRevisions).toHaveBeenLastCalledWith(current.id, 1001)
  const history = find(render(), value => value.props?.['aria-label'] === '文档历史版本')
  expect(find(render(), value => value.props?.role === 'dialog').props['aria-labelledby']).toBe(headingId)
  expect(history.props.children.flat().filter((value: any) => value?.type === 'div').map((value: any) => value.key)).toEqual(['1002', '1001', '1000'])
})

describe('layer selection follows displayed tree order', () => {
  const rows = ['top', 'child', 'middle', 'bottom']
  test('Shift selects a continuous range in both directions', () => {
    expect(layerSelection(rows, ['top'], 'middle', 'top', { range: true })).toEqual(['top', 'child', 'middle'])
    expect(layerSelection(rows, ['bottom'], 'child', 'bottom', { range: true })).toEqual(['child', 'middle', 'bottom'])
  })
  test('Command toggles and Command+Shift extends without losing the prior selection', () => {
    expect(layerSelection(rows, ['top', 'middle'], 'top', 'middle', { toggle: true })).toEqual(['middle'])
    expect(layerSelection(rows, ['top'], 'bottom', 'middle', { toggle: true, range: true })).toEqual(['top', 'middle', 'bottom'])
  })
  test('a hidden or removed anchor cannot select an unrelated range', () => {
    expect(layerSelection(rows, ['top'], 'bottom', 'removed', { range: true })).toEqual(['bottom'])
  })
  test('actual layer rows use Shift ranges, Command toggles and inline rename', () => {
    const focusCanvas=vi.fn();vi.stubGlobal('document',{querySelector:vi.fn(()=>({focus:focusCanvas}))})
    try {
    const { editor, ids } = fixture(), third = editor.add('rectangle', { x: 400, y: 20, width: 80, height: 80 })
    const harness = componentHarness(), render = () => harness.render(() => Layers({ editor }))
    const row = (id: string) => find(render(), (value) => value.props?.['data-testid'] === `layer-${id}`)
    row(third).props.onClick({ shiftKey: false, metaKey: false, ctrlKey: false })
    row(ids[0]).props.onClick({ shiftKey: true, metaKey: false, ctrlKey: false })
    expect(editor.state.selection).toEqual([third, ids[1], ids[0]])
    row(ids[1]).props.onClick({ shiftKey: false, metaKey: true, ctrlKey: false })
    expect(editor.state.selection).toEqual([third, ids[0]])
    row(ids[1]).props.onDoubleClick()
    const rename = find(render(), (value) => value.props?.['aria-label'] === '重命名图层')
    expect(rename.props.autoFocus).toBe(true)
    rename.props.onCommit('已命名图层')
    expect(editor.state.doc.nodes[ids[1]].name).toBe('已命名图层')
    expect(editor.state.doc.nodes[ids[0]].name).not.toBe('已命名图层')
    expect(find(render(), (value) => value.props?.['aria-label'] === '重命名图层')).toBeUndefined()
    editor.undo(); expect(editor.state.doc.nodes[ids[1]].name).not.toBe('已命名图层')
    expect(focusCanvas).toHaveBeenCalledTimes(3)
    editor.dispose()
    } finally {vi.unstubAllGlobals()}
  })
})

describe('mixed selection properties', () => {
  test('batch text fill changes rendered color overrides and preserves unrelated rich text', () => {
    const doc = blank(), a = node('text', 0, 0, 100, 40), b = node('text', 120, 0, 100, 40)
    for (const n of [a, b]) { n.text = 'A'; n.fills = [paint('#ffffff')]; n.textRuns = [{ start: 0, end: 1, color: '#ffffff', weight: 700, underline: true }] }
    doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
    const editor = new Editor(doc)
    try {
      const before = editor.state.doc
      const field = find(MultiStylePanel({editor,nodes:[a,b],field:'fills'}), value => value.props?.['aria-label'] === '填充 1颜色')
      field.props.onCommit('#ffcc00')
      for (const id of [a.id, b.id]) {
        const n = editor.state.doc.nodes[id]
        expect(n.fills[0].color).toBe('#ffcc00')
        expect(n.textRuns?.[0]).toMatchObject({ weight: 700, underline: true })
        expect(n.textRuns?.[0].color).toBeUndefined()
      }
      editor.undo(); expect(editor.state.doc).toEqual(before)
    } finally { editor.dispose() }
  })
  test('differing values display Mixed with no first-node number', () => {
    const html = renderToStaticMarkup(<MixedNumberField label="W" value={commonValue([100, 240])} onChange={() => {}} />)
    expect(html).toContain('placeholder="混合"')
    expect(html).toContain('value=""')
    expect(html).not.toContain('value="100"')
    expect(commonValue([0, 0])).toBe(0)
    expect(commonValue([false, true])).toBeUndefined()
  })
  test('one explicit width edit updates both selected shapes and has one undo boundary', () => {
    const { editor, ids, panel } = fixture()
    const field = find(panel(), (value) => value.type === MixedNumberField && value.props.label === 'W')
    expect(field.props.value).toBeUndefined()
    field.props.onChange(160)
    expect(ids.map((id) => selectionMetric(editor.state.doc.nodes[id], 'width'))).toEqual([160, 160])
    expect(ids.map((id) => editor.state.doc.nodes[id].fills[0].color)).toEqual(['#ff0000', '#0000ff'])
    editor.undo()
    expect(ids.map((id) => selectionMetric(editor.state.doc.nodes[id], 'width'))).toEqual([100, 240])
    editor.dispose()
  })
  test('mixed solid colors stay blank until the user supplies a shared value', () => {
    const { editor, ids, panel } = fixture()
    const field = find(MultiStylePanel({editor,nodes:ids.map(id=>editor.state.doc.nodes[id]),field:'fills'}), (value) => value.props?.['aria-label'] === '填充 1颜色')
    expect(field.props.value).toBe('')
    expect(field.props.placeholder).toBe('混合')
    field.props.onCommit('#00ff00')
    expect(ids.map((id) => editor.state.doc.nodes[id].fills[0].color)).toEqual(['#00ff00', '#00ff00'])
    editor.undo()
    expect(ids.map((id) => editor.state.doc.nodes[id].fills[0].color)).toEqual(['#ff0000', '#0000ff'])
    editor.dispose()
  })
})
