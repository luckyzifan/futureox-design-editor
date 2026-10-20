import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, type DesignDocument } from './model'
import { ColorEditSession } from './color-edit-session'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge } from './desktop'
import { dispatchEditorCommand } from './editor-commands'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport, type BridgeDependencies } from './automation/bridge'
const dispose: Array<() => void> = []
afterEach(() => { dispose.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const d = blank('Authored document'), n = node('rectangle', 0, 0, 60, 50); n.fills[0].color = '#123456'
  d.nodes[n.id] = n; d.pages[0].children = [n.id]
  const editor = new Editor(d); editor.select([n.id]); dispose.push(() => editor.dispose())
  const open = () => ColorEditSession.open(editor, { kind: 'solid-fill', nodeId: n.id, fillIndex: 0, fillId: n.fills[0].id })!
  return { editor, n, open }
}
function desktop() {
  const f = fixture(), ok = { status: 'ok' } as const
  const bridge = {
    version: 1, renderPolicy: Object.freeze({ cpuOnly: true }),
    readRecovery: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    writeRecovery: vi.fn().mockResolvedValue(ok), clearRecovery: vi.fn().mockResolvedValue(ok),
    saveDocument: vi.fn().mockResolvedValue({ ...ok, handle: 'fixture', displayName: 'saved.fd' }),
    acceptDocument: vi.fn().mockResolvedValue(ok), setDirty: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge
  const session = new DesktopSession(bridge, f.editor, async () => 'discard'); dispose.push(() => session.dispose())
  return { ...f, bridge, session }
}
test('desktop failed save/recovery never serializes preview; valid Save settles one property edit', async () => {
  vi.useFakeTimers()
  const f = desktop(); await f.session.start(); await f.session.save()
  vi.mocked(f.bridge.writeRecovery).mockClear(); vi.mocked(f.bridge.saveDocument).mockClear()
  const base = f.editor.authoredDocument, s = f.open(); s.update({ color: '#abcdef' }); s.update({ opacity: 'invalid' })
  expect(await f.session.save()).toBe(false); expect(f.bridge.saveDocument).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(700)
  expect(f.bridge.writeRecovery).toHaveBeenCalled()
  for (const [request] of vi.mocked(f.bridge.writeRecovery).mock.calls) {
    const persisted = JSON.parse(request.documentJson)
    expect(persisted.nodes[f.n.id].fills[0].color).toBe('#123456')
    expect(persisted).toEqual(base)
  }
  s.update({ opacity: '20' }); expect(await f.session.save()).toBe(true)
  expect(f.editor.state.version).toBe(1); expect(s.active).toBe(false)
  const saved = JSON.parse(vi.mocked(f.bridge.saveDocument).mock.calls[0][0].documentJson)
  expect(saved.nodes[f.n.id].fills[0]).toMatchObject({ color: '#abcdef', opacity: .2 })
})
test('desktop replacement vetoes invalid draft and retires valid draft before new session', async () => {
  const f = desktop(); await f.session.start(); await f.session.save()
  const s = f.open(); s.update({ color: '#bad' }); const preview = f.editor.state.doc
  expect(await f.session.replace(blank('Blocked'))).toBe(false); expect(f.editor.state.doc).toBe(preview); expect(s.active).toBe(true)
  s.update({ color: '#abcdef' }); expect(await f.session.replace(blank('Replacement'))).toBe(true)
  const replacement = f.editor.state.doc, selection = f.editor.state.selection
  expect(replacement.name).toBe('Replacement'); expect(s.active).toBe(false)
  s.cancel(); expect(f.editor.state.doc).toBe(replacement); expect(f.editor.state.selection).toBe(selection)
})
test('desktop save preserves generic pointer guard and does not auto-commit a gesture', async () => {
  const f = desktop(); await f.session.start(); f.editor.begin('drag')
  f.editor.preview({ [f.n.id]: { width: 91 } }); const preview = f.editor.state.doc
  expect(await f.session.save()).toBe(false); expect(f.editor.interactionActive).toBe(true)
  expect(f.editor.state.doc).toBe(preview); expect(f.editor.state.version).toBe(0); expect(f.bridge.saveDocument).not.toHaveBeenCalled()
})
test('clipboard copy/cut settle valid draft; invalid draft cannot copy stale or preview values or delete target', async () => {
  const f = fixture(), writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const invalid = f.open(); invalid.update({ color: '#abcdef' }); invalid.update({ color: '#invalid' })
  await dispatchEditorCommand(f.editor, 'copy'); await dispatchEditorCommand(f.editor, 'cut')
  expect(writeText).not.toHaveBeenCalled(); expect(f.editor.state.doc.nodes[f.n.id]).toBeTruthy(); expect(f.editor.state.version).toBe(0)
  invalid.update({ color: '#fedcba' }); await dispatchEditorCommand(f.editor, 'copy')
  expect(writeText).toHaveBeenCalledTimes(1); expect(writeText.mock.calls[0][0]).toContain('#fedcba'); expect(f.editor.state.version).toBe(1)
  const cutting = f.open(); cutting.update({ opacity: '35' }); await dispatchEditorCommand(f.editor, 'cut')
  expect(writeText).toHaveBeenCalledTimes(2); expect(writeText.mock.calls[1][0]).toContain('0.35')
  expect(f.editor.state.doc.nodes[f.n.id]).toBeUndefined(); expect(f.editor.state.version).toBe(3)
  f.editor.undo(); expect(f.editor.state.doc.nodes[f.n.id].fills[0].opacity).toBe(.35)
  f.editor.undo(); expect(f.editor.state.doc.nodes[f.n.id].fills[0].opacity).toBe(1)
})
test('MCP preview/raster/vector read pipelines receive authored snapshots, not rendered property drafts', async () => {
  const f = fixture(), snapshots: DesignDocument[] = []
  const capturePreview = vi.fn(async (document: DesignDocument) => { snapshots.push(document); return { dataUrl: 'data:image/png;base64,AAAA' } }) as unknown as BridgeDependencies['capturePreview']
  const captureRaster = vi.fn(async (document: DesignDocument) => { snapshots.push(document); return { assets: [{ blob: new Blob(['raster'], { type: 'image/png' }), name: 'test.png' }] } }) as unknown as BridgeDependencies['captureRaster']
  const captureSvgArtifact = vi.fn(async (document: DesignDocument) => { snapshots.push(document); return { blob: new Blob(['svg'], { type: 'image/svg+xml' }), name: 'test.svg', options: { compression: 'none' } } }) as unknown as BridgeDependencies['captureSvgArtifact']
  let receive!: (v: DesktopAutomationRequest) => void, serial = 0
  const waiters = new Map<string, (v: any) => void>()
  const transport = {
    register: vi.fn(async () => {}), recordEdit: vi.fn(async () => ({ accepted: true })),
    respond: vi.fn(async (v: any) => { waiters.get(v.requestId)?.(v.result ?? v.error) }),
    onRequest(fn: typeof receive) { receive = fn; return () => {} }, onCancel() { return () => {} },
  } as unknown as DesktopAutomationTransport
  dispose.push(attachDesktopAutomation(f.editor, transport, { capturePreview, captureRaster, captureSvgArtifact }))
  const call = (method: string, params = {}) => {
    const requestId = `read-${++serial}`, result = new Promise<any>(resolve => waiters.set(requestId, resolve))
    receive({ requestId, kind: 'execute', sessionId: 'authorized-read-fixture', scope: 'read', documentId: f.editor.state.doc.id,
      session: f.editor.sessionGeneration, deadline: Date.now() + 15_000, request: { method, params, documentId: f.editor.state.doc.id, session: f.editor.sessionGeneration, expectedRevision: f.editor.state.version } })
    return result
  }
  const s = f.open(); s.update({ color: '#abcdef' })
  const preview = await call('preview.capture'); expect(preview.ok, JSON.stringify(preview)).toBe(true)
  expect((await call('raster.export', { format: 'png', scales: [1] })).ok).toBe(true)
  expect((await call('vector.exportArtifact')).ok).toBe(true)
  expect(snapshots).toHaveLength(3)
  for (const snapshot of snapshots) expect(snapshot.nodes[f.n.id].fills[0].color).toBe('#123456')
  expect(f.editor.state.doc.nodes[f.n.id].fills[0].color).toBe('#abcdef'); expect(f.editor.state.version).toBe(0)
})
test('desktop cancelling back to the saved base clears dirty/recovery state without an authored revision', async () => {
  vi.useFakeTimers()
  const f = desktop(); await f.session.start(); await f.session.save(); expect(f.session.dirty).toBe(false)
  const s = f.open(); s.update({ color: '#abcdef' }); expect(f.session.dirty).toBe(true)
  s.cancel(); await vi.advanceTimersByTimeAsync(700)
  expect(f.editor.state.version).toBe(0); expect(f.session.dirty).toBe(false)
  expect(vi.mocked(f.bridge.saveDocument).mock.calls).toHaveLength(1)
})
test('workspace tab switching vetoes invalid draft and adopts the new authored head without stale rollback', async () => {
  const f = desktop(); await f.session.start(); await f.session.save()
  const next = blank('Another tab'), target = node('rectangle'); next.nodes[target.id] = target; next.pages[0].children = [target.id]
  Object.defineProperty(f.bridge, 'workspace', { value: { open: vi.fn().mockResolvedValue({ status: 'ok', id: next.id, name: next.name,
    revision: 1, hash: 'fixture-hash', updatedAt: 1, documentJson: JSON.stringify(next) }) } })
  const s = f.open(); s.update({ color: '#invalid' }); const previous = f.editor.state.doc
  expect(await f.session.openWorkspace(next.id)).toBe(false)
  expect(f.editor.state.doc).toBe(previous); expect(s.active).toBe(true)
  s.update({ color: '#abcdef' }); expect(await f.session.openWorkspace(next.id)).toBe(true)
  const adopted = f.editor.state.doc; expect(adopted.id).toBe(next.id); expect(f.session.activeDocumentId).toBe(next.id)
  f.editor.select([target.id]); s.cancel()
  expect(f.editor.state.doc).toBe(adopted); expect(f.editor.state.selection).toEqual([target.id]); expect(s.active).toBe(false)
})
