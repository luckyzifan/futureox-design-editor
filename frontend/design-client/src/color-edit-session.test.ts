import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint } from './model'
import { componentFixture, originNode } from './component-fixtures'
import { emptySystem } from './design-system'
import { defaultColorSettings } from './color'
import { ColorEditSession } from './color-edit-session'
import { commitExportEdits, ExportOwner } from './export-ownership'
import { activateTool } from './tool-activation'
import { dispatchEditorCommand } from './editor-commands'
import { hasPendingEdits } from './pending-edits'
import { createDesignAutomation } from './automation/core'
import { canvasActions, ActionOutcome } from './canvas-action-diagnostics'
import type { PropertyPreviewLease, SolidFillTarget } from './property-preview'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture(color = '#123456', managed = false) {
  const document = blank(), first = node('rectangle', 0, 0, 80, 60), second = node('rectangle', 100, 0, 40, 40)
  first.fills = [paint(color), paint('#fedcba')]; first.opacity = .73; first.fills[0].opacity = .61
  document.nodes[first.id] = first; document.nodes[second.id] = second; document.pages[0].children = [first.id, second.id]
  if (managed) { document.schemaVersion = Math.max(3, document.schemaVersion) as typeof document.schemaVersion; document.colorManagement = defaultColorSettings(); document.rasterProfile = 'figma' }
  const editor = new Editor(document); editors.push(editor); editor.select([first.id])
  const target: SolidFillTarget = { kind: 'solid-fill', nodeId: first.id, fillId: first.fills[0].id, fillIndex: 0 }
  const current = () => editor.state.doc.nodes[first.id]
  const open = () => ColorEditSession.open(editor, target)!
  return { editor, target, first, second, current, open }
}
test('50 real previews leave authored revision fixed; one commit, one undo, exact paint/layer separation', () => {
  const f = fixture(), base = f.editor.state.doc, draft = f.open()
  expect(draft).toBeTruthy()
  for (let i = 0; i < 50; i++) {
    expect(draft.update({ color: '#' + i.toString(16).padStart(6, '0'), opacity: String(i + 1) })).toBe('preview')
    expect(f.editor.state.version).toBe(0)
    expect(f.editor.authoredDocument).toBe(base)
    expect(f.current().opacity).toBe(.73)
  }
  expect(draft.commit()).toBe(true)
  expect(f.editor.state.version).toBe(1)
  expect(f.current().fills[0]).toMatchObject({ color: '#000031', opacity: .5 })
  expect(f.current().fills[1]).toEqual(base.nodes[f.first.id].fills[1])
  f.editor.undo(); expect(f.editor.state.doc).toBe(base); expect(f.editor.canUndo).toBe(false)
  f.editor.redo(); expect(f.current().fills[0].color).toBe('#000031')
})
test('Escape/cancel restores exact base, unchanged open-close creates no history', () => {
  const f = fixture(), base = f.editor.state.doc
  const a = f.open(); a.update({ color: '#abcdef', opacity: '9' }); a.cancel()
  expect(f.editor.state.doc).toBe(base); expect(f.editor.state.version).toBe(0); expect(f.editor.canUndo).toBe(false)
  const b = f.open(); expect(b.commit()).toBe(true)
  expect(f.editor.state.doc).toBe(base); expect(f.editor.state.version).toBe(0); expect(f.editor.canUndo).toBe(false)
  const c = f.open(); c.update({ color: '#abcdef' }); c.update({ color: c.original.color }); c.commit()
  expect(f.editor.state.doc).toBe(base); expect(f.editor.state.version).toBe(0)
})
test.each(['', '#12', 'rgb(1,2,3)', 'color(srgb NaN 1 1)', 'color(srgb 1 1 1 / 2)'])('invalid color %s stays local, vetoes boundary, and can be repaired', invalid => {
  const f = fixture(), s = f.open(); s.update({ color: '#abcdef' }); const preview = f.editor.state.doc
  expect(s.update({ color: invalid })).toBe('blocked'); expect(f.editor.state.doc).toBe(preview)
  expect(f.editor.settleOwnedPropertyPreview('save')).toBe(false); expect(s.commit()).toBe(false)
  expect(f.editor.state.version).toBe(0); expect(hasPendingEdits(f.editor)).toBe(true)
  s.update({ color: '#cdefab' }); expect(s.commit()).toBe(true); expect(f.current().fills[0].color).toBe('#cdefab')
})
test.each(['', '-1', '101', 'NaN', '1e2'])('invalid opacity %s never changes preview or layer opacity', invalid => {
  const f = fixture(), s = f.open(), base = f.editor.state.doc
  expect(s.update({ opacity: invalid })).toBe('blocked'); expect(f.editor.state.doc).toBe(base)
  expect(f.editor.settleOwnedPropertyPreview('export')).toBe(false); expect(f.current().opacity).toBe(.73)
  s.cancel(); expect(f.editor.state.version).toBe(0)
})
test.each(['color(display-p3 1.12 -.03 .61 / .37)', 'color(srgb-linear 4 0.125 -0.02 / 0.25)', 'color(rec2100-linear 9 3 0 / .63)'])('HDR strings survive no-op, alpha-only commit, cancel and undo byte-for-byte: %s', color => {
  const f = fixture(color, true), base = f.editor.state.doc
  f.open().commit(); expect(f.editor.state.doc).toBe(base)
  const s = f.open(); s.update({ opacity: '20' }); expect(f.current().fills[0].color).toBe(color); s.commit()
  expect(f.current().fills[0].color).toBe(color); expect(f.current().fills[0].opacity).toBe(.2); expect(f.current().opacity).toBe(.73)
  f.editor.undo(); expect(f.editor.state.doc).toBe(base)
  const c = f.open(); c.update({ color: 'color(srgb-linear 2 0 1 / .1)' }); c.cancel(); expect(f.editor.state.doc).toBe(base)
})
test('first Undo cancels draft only; second Undo visits authored history', async () => {
  const f = fixture(); f.editor.updateProperties([f.first.id], n => { n.opacity = .4 })
  const base = f.editor.state.doc, version = f.editor.state.version, s = f.open(); s.update({ color: '#ffffff' })
  await dispatchEditorCommand(f.editor, 'undo')
  expect(f.editor.state.doc).toBe(base); expect(f.editor.state.version).toBe(version); expect(s.active).toBe(false)
  f.editor.undo(); expect(f.current().opacity).toBe(.73)
})
test('unrelated authored edit settles lease first; stale cancel cannot remove newer edit or selection', () => {
  const f = fixture(), s = f.open(); s.update({ color: '#abcdef' })
  f.editor.updateProperties([f.second.id], n => { n.name = 'New authored content' })
  f.editor.select([f.second.id]); const newer = f.editor.state.doc, version = f.editor.state.version
  expect(version).toBe(2); expect(f.current().fills[0].color).toBe('#abcdef')
  expect(f.editor.previewProperty(s.lease, { color: '#ffffff' })).toBe('stale')
  expect(f.editor.cancelProperty(s.lease)).toBe('stale'); expect(f.editor.state.doc).toBe(newer)
  expect(f.editor.state.selection).toEqual([f.second.id]); expect(f.editor.state.version).toBe(version)
})
test('reorder/delete retire lease; late color cannot redirect into a replacement slot', () => {
  const f = fixture(), s = f.open(); s.update({ color: '#abcdef' })
  f.editor.updateProperties([f.first.id], n => { n.fills.reverse() })
  const document = f.editor.state.doc
  expect(f.editor.previewProperty(s.lease, { color: '#ffffff' })).toBe('stale')
  expect(f.current().fills.map(p => p.color)).toEqual(['#fedcba', '#abcdef'])
  expect(f.editor.state.doc).toBe(document)
  expect(f.editor.acquirePropertyPreview([f.target])).toBe(null)
  f.editor.remove(); s.cancel(); expect(f.editor.state.doc.nodes[f.first.id]).toBeUndefined()
})
test('invalid draft vetoes selection/page/load; valid navigation settles once', () => {
  const f = fixture(), s = f.open(); s.update({ color: '#xx' }); const old = f.editor.state.doc
  f.editor.select([f.second.id]); expect(f.editor.state.selection).toEqual([f.first.id])
  expect(f.editor.load(blank('replacement'))).toBe(false); expect(f.editor.state.doc).toBe(old)
  s.update({ color: '#abcdef' }); f.editor.select([f.second.id]); expect(f.editor.state.version).toBe(1)
  expect(f.editor.state.selection).toEqual([f.second.id]); expect(s.active).toBe(false)
})
test('external snapshot/session replacement invalidates without rolling back new content', () => {
  const f = fixture(), s = f.open(); s.update({ color: '#abcdef' })
  const replacement = blank('New authoritative document'), n = node('rectangle')
  replacement.nodes[n.id] = n; replacement.pages[0].children = [n.id]
  f.editor.set({ doc: replacement, page: replacement.pages[0].id, selection: [n.id], version: 10 })
  expect(s.active).toBe(false); expect(f.editor.authoredDocument).toBe(replacement)
  s.cancel(); expect(f.editor.state.doc).toBe(replacement); expect(f.editor.state.selection).toEqual([n.id])
  expect(f.editor.state.version).toBe(10)
  const target: SolidFillTarget = { kind: 'solid-fill', nodeId: n.id, fillIndex: 0, fillId: n.fills[0].id }
  const next = ColorEditSession.open(f.editor, target)!; next.update({ color: '#000000' })
  expect(f.editor.load(blank('Reset session'))).toBe(true)
  const reset = f.editor.state.doc; next.cancel(); expect(f.editor.state.doc).toBe(reset)
})
test('stale selection cancellation removes only owned preview, preserving newer selected ids', () => {
  const f = fixture(), base = f.editor.state.doc, s = f.open(); s.update({ color: '#abcdef' })
  // Simulate an external host bypassing normal selection admission.
  f.editor.state = { ...f.editor.state, selection: [f.second.id] }
  expect(f.editor.authoredDocument).toBe(base)
  expect(f.editor.cancelProperty(s.lease)).toBe('stale')
  expect(f.editor.state.doc).toBe(base); expect(f.editor.state.selection).toEqual([f.second.id])
})
test('opaque capability cannot borrow another Editor or an existing pointer gesture', () => {
  const f = fixture(), g = fixture(); f.editor.begin('move')
  expect(f.editor.acquirePropertyPreview([f.target])).toBe(null)
  f.editor.preview({ [f.first.id]: { width: 90 } }); const pointer = f.editor.state.doc
  expect(f.editor.cancelProperty({} as PropertyPreviewLease)).toBe('stale'); expect(f.editor.state.doc).toBe(pointer)
  expect(f.editor.authoredDocument).toBe(pointer) // Existing generic gesture semantics unchanged.
  f.editor.commit(); expect(f.editor.state.version, f.editor.state.message).toBe(1)
  const s = f.open(); expect(g.editor.previewProperty(s.lease, { color: '#ffffff' })).toBe('stale')
  s.cancel(); f.editor.begin('new move'); f.editor.preview({ [f.first.id]: { width: 95 } })
  const newer = f.editor.state.doc; s.cancel(); expect(f.editor.state.doc).toBe(newer); expect(f.editor.interactionActive).toBe(true)
})
test('stale async sample after typing/cancellation/new lease cannot change any document', async () => {
  const f = fixture(), s = f.open(); let resolve!: (v: { sRGBHex: string }) => void
  const p = s.sample(() => new Promise(done => { resolve = done }))
  s.update({ color: '#aabbcc' }); resolve({ sRGBHex: '#ffffff' }); await p
  expect(f.current().fills[0].color).toBe('#aabbcc')
  const q = s.sample(() => new Promise(done => { resolve = done })); s.cancel()
  const next = f.open(); next.update({ color: '#112233' }); const preview = f.editor.state.doc
  resolve({ sRGBHex: '#ff0000' }); await q; expect(f.editor.state.doc).toBe(preview)
})
test('composition blocks all boundaries; completion previews and cancel discards', () => {
  const f = fixture(), s = f.open(), base = f.editor.state.doc
  s.setComposing(true); s.update({ color: '#abcdef' }); expect(f.editor.state.doc).toBe(base)
  expect(s.commit()).toBe(false); expect(commitExportEdits(f.editor)).toBe(false)
  s.setComposing(false); expect(f.current().fills[0].color).toBe('#abcdef'); s.cancel(); expect(f.editor.state.doc).toBe(base)
})
test('export/copy/tool boundaries settle only owned valid drafts; raw ExportOwner never snapshots property preview', async () => {
  const f = fixture(), s = f.open(); s.update({ color: '#abcdef' })
  const owner = new ExportOwner(); owner.activate(f.editor)
  expect(owner.begin(f.editor, 'unsettled')).toBe(null)
  expect(commitExportEdits(f.editor)).toBe(true); const request = owner.begin(f.editor, 'settled')!
  expect(request.document.nodes[f.first.id].fills[0].color).toBe('#abcdef'); expect(f.editor.state.version).toBe(1); owner.dispose()
  const invalid = f.open(); invalid.update({ color: 'secret-invalid-color' }); expect(f.editor.exportClipboard()).toBe(null)
  await activateTool(f.editor, 'ellipse'); expect(f.editor.state.tool).toBe('select'); invalid.cancel()
  const c = f.open(); c.update({ opacity: '31' }); const copied = JSON.parse(f.editor.exportClipboard()!)
  expect(copied.document.nodes[f.first.id].fills[0].opacity).toBe(.31); expect(c.active).toBe(false)
  const t = f.open(); t.update({ color: '#0000ff' }); await activateTool(f.editor, 'ellipse')
  expect(f.editor.state.tool).toBe('ellipse'); expect(t.active).toBe(false)
  f.editor.begin('pointer'); f.editor.preview({ [f.first.id]: { width: 101 } })
  await activateTool(f.editor, 'rectangle'); expect(f.editor.interactionActive).toBe(true); expect(f.editor.state.tool).toBe('ellipse')
})
test('read-only MCP sees authored values and mutations remain blocked by a property lease', () => {
  const f = fixture(), api = createDesignAutomation(f.editor), base = f.editor.state.doc, s = f.open()
  s.update({ color: '#abcdef' })
  const read = api.execute({ method: 'node.get', params: { id: f.first.id } })
  expect(read.ok).toBe(true)
  if (read.ok) expect((read.result as any).node.fills[0].color).toBe(base.nodes[f.first.id].fills[0].color)
  const edit = api.execute({ method: 'node.update', params: { ids: [f.first.id], patch: { opacity: .2 } },
    documentId: base.id, expectedRevision: 0, session: f.editor.sessionGeneration })
  expect(edit.ok).toBe(false); if (!edit.ok) expect(edit.error.code).toBe('interaction_active')
  expect(f.current().opacity).toBe(.73); expect(f.editor.state.version).toBe(0)
})
test('reentrant subscribers never inherit the private preview-write capability', () => {
  const f = fixture(), s = f.open(); let entered = false
  const stop = f.editor.subscribe(() => {
    if (entered || !f.editor.propertyPreviewActive || f.current().fills[0].color !== '#abcdef') return
    entered = true; f.editor.updateProperties([f.second.id], n => { n.name = 'Independent edit' })
  })
  expect(s.update({ color: '#abcdef' })).toBe('stale'); stop()
  expect(f.editor.state.version).toBe(2); expect(f.editor.state.doc.nodes[f.second.id].name).toBe('Independent edit')
  s.cancel(); f.editor.undo(); expect(f.current().fills[0].color).toBe('#abcdef'); f.editor.undo(); expect(f.current().fills[0].color).toBe('#123456')
})
test('content-free diagnostics aggregate samples and never claim rejected/no-op drafts committed', () => {
  vi.stubGlobal('window', { coreDesktop: { renderDiagnostics: true, renderDiagnosticsDetail: true } })
  const logs: string[] = []; vi.spyOn(console, 'log').mockImplementation(value => logs.push(String(value)))
  const f = fixture(), s = f.open()
  for (let i = 0; i < 50; i++) s.update({ color: '#abcdef', opacity: String(i) })
  s.update({ color: 'private-color-secret' }); expect(s.commit()).toBe(false); s.cancel()
  const rows = canvasActions(f.editor).snapshot().rows
  expect(rows.filter(r => r.actionPhase === 2 && r.actionOutcome === ActionOutcome.committed)).toHaveLength(0)
  expect(rows.filter(r => r.actionPhase === 2 && r.fieldFamily === 9)).toHaveLength(1)
  expect(rows.every(r => Object.values(r).every(v => v === undefined || typeof v === 'number'))).toBe(true)
  const text = JSON.stringify(rows) + logs.join('\n')
  for (const secret of ['private-color-secret', '#abcdef', f.first.id, 'fills.0']) expect(text).not.toContain(secret)
})

test('typed multi-target opacity preview preserves heterogeneous colors and commits atomically', () => {
  const f = fixture(); f.editor.select([f.first.id, f.second.id]); const before = f.editor.state.doc
  const second = before.nodes[f.second.id]
  const lease = f.editor.acquirePropertyPreview([f.target, { kind: 'solid-fill', nodeId: second.id, fillId: second.fills[0].id, fillIndex: 0 }])!
  expect(f.editor.previewProperty(lease, { opacity: .21 })).toBe('preview')
  for (const id of [f.first.id, f.second.id]) {
    expect(f.editor.state.doc.nodes[id].fills[0].opacity).toBe(.21)
    expect(f.editor.state.doc.nodes[id].fills[0].color).toBe(before.nodes[id].fills[0].color)
  }
  expect(f.editor.commitProperty(lease)).toBe('committed'); expect(f.editor.state.version).toBe(1)
  f.editor.undo(); expect(f.editor.state.doc).toBe(before)
})
test.each(['variable', 'style'] as const)('linked %s fills are read-only, without implicit detachment', kind => {
  const d = blank(), n = node('rectangle'); d.schemaVersion = 6; d.nodes[n.id] = n; d.pages[0].children = [n.id]
  const system = d.designSystem = emptySystem()
  if (kind === 'variable') {
    system.collections.theme = { name: 'Theme', modes: ['Default'], defaultMode: 'Default' }; system.activeModes.theme = 'Default'
    system.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { Default: '#123456' } }
    n.bindings = { 'fills.0.color': 'brand' }
  } else { system.styles.brand = { name: 'Brand', kind: 'paint', value: [paint('#123456')] }; n.styleRefs = { fills: 'brand' } }
  const editor = new Editor(d); editors.push(editor); editor.select([n.id]); const before = editor.state.doc, p = before.nodes[n.id].fills[0]
  expect(ColorEditSession.open(editor, { kind: 'solid-fill', nodeId: n.id, fillId: p.id, fillIndex: 0 })).toBe(null)
  expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(0)
  expect(editor.state.doc.nodes[n.id].bindings).toEqual(before.nodes[n.id].bindings)
  expect(editor.state.doc.nodes[n.id].styleRefs).toEqual(before.nodes[n.id].styleRefs)
})
test('instance preview captures only local overrides, restores them on cancel and commits one undo', () => {
  const { doc, ids } = componentFixture(), editor = new Editor(doc); editors.push(editor)
  const key = editor.state.doc.nodes[ids.label].componentKey!, child = originNode(editor.state.doc, ids.a, key)
  editor.select([child.id]); const before = editor.state.doc
  const target: SolidFillTarget = { kind: 'solid-fill', nodeId: child.id, fillId: child.fills[0].id, fillIndex: 0 }
  const cancelled = ColorEditSession.open(editor, target)!; cancelled.update({ color: '#abcdef' }); cancelled.cancel()
  expect(editor.state.doc).toBe(before)
  const committed = ColorEditSession.open(editor, target)!; expect(committed.update({ color: '#112233' })).toBe('preview')
  expect(originNode(editor.state.doc, ids.b, key).fills[0].color).toBe(originNode(before, ids.b, key).fills[0].color)
  expect(editor.state.doc.nodes[ids.label]).toEqual(before.nodes[ids.label])
  expect(committed.commit()).toBe(true); expect(editor.state.version).toBe(1)
  expect((editor.state.doc.nodes[ids.a].instance!.overrides[key].fills as ReturnType<typeof paint>[])[0].color).toBe('#112233')
  editor.undo(); expect(editor.state.doc).toBe(before)
})
test('paint-only opacity preserves text-run colors; color revert restores all run representations', () => {
  const d = blank(), n = node('text', 0, 0, 120, 40); d.schemaVersion = 4; n.text = 'abc'; n.textRuns = [{ start: 0, end: 2, color: '#aabbcc' }]
  d.nodes[n.id] = n; d.pages[0].children = [n.id]
  const editor = new Editor(d); editors.push(editor); editor.select([n.id]); const base = editor.state.doc
  const target: SolidFillTarget = { kind: 'solid-fill', nodeId: n.id, fillIndex: 0, fillId: n.fills[0].id }
  const s = ColorEditSession.open(editor, target)!; s.update({ opacity: '30' })
  expect(editor.state.doc.nodes[n.id].textRuns).toEqual(base.nodes[n.id].textRuns); s.cancel()
  const revert = ColorEditSession.open(editor, target)!
  revert.update({ color: '#abcdef' }); expect(editor.state.doc.nodes[n.id].textRuns?.[0].color).toBeUndefined()
  revert.update({ color: revert.original.color }); expect(revert.commit()).toBe(true)
  expect(editor.state.doc).toBe(base); expect(editor.state.version).toBe(0)
})
