import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { dispatchEditorCommand, editorCommands } from './editor-commands'
import { canvasActions, CanvasAction, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import { worldMatrix } from './geometry'
import { createKeyboardNudgeGesture } from './keyboard-nudge-gesture'
const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fresh() {
  let packet: unknown
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('window', { coreDesktop: { version: 1, renderDiagnostics: true, renderDiagnosticsDetail: true,
    clipboard: { write: async (value: unknown) => { packet = value; return { status: 'ok' } }, read: async () => ({ status: 'ok', ...(packet as object) }) } } })
  const editor = new Editor(blank('DO_NOT_LOG_DOCUMENT')); editors.push(editor); return editor
}
const finals = (editor: Editor, action: number) => canvasActions(editor).snapshot().rows.filter(r => r.actionPhase === 2 && r.actionCode === action)
describe('actual fresh-canvas action routes', () => {
  it('creates/selects, copies/pastes, moves and undoes/redoes real model geometry without content in records', async () => {
    const editor = fresh()
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
    const original = editor.add('rectangle', { x: 10, y: 20, width: 30, height: 40 })
    expect(editor.state.selection).toEqual([original])
    await dispatchEditorCommand(editor, 'copy')
    expect(finals(editor, CanvasAction.copy).at(-1)?.actionOutcome).toBe(ActionOutcome.observed)
    await dispatchEditorCommand(editor, 'paste-in-place')
    const pasted = editor.state.selection[0]
    expect(pasted).not.toBe(original)
    expect(worldMatrix(editor.state.doc, pasted)).toEqual(worldMatrix(editor.state.doc, original))
    const before = worldMatrix(editor.state.doc, pasted)
    editor.transformSelection([1, 0, 0, 1, 17, 23])
    const moved = worldMatrix(editor.state.doc, pasted)
    expect(moved[4]).toBe(before[4] + 17); expect(moved[5]).toBe(before[5] + 23)
    await dispatchEditorCommand(editor, 'undo'); expect(worldMatrix(editor.state.doc, pasted)).toEqual(before)
    await dispatchEditorCommand(editor, 'redo'); expect(worldMatrix(editor.state.doc, pasted)).toEqual(moved)
    expect(finals(editor, CanvasAction.paste).some(r => r.actionOutcome === ActionOutcome.committed)).toBe(true)
    const rows = JSON.stringify(canvasActions(editor).snapshot().rows)
    for (const content of ['DO_NOT_LOG_DOCUMENT', original, pasted, 'rectangle']) expect(rows).not.toContain(content)
  })
  it('reports busy commands and empty-target noops without claiming commits', async () => {
    const editor = fresh()
    await dispatchEditorCommand(editor, 'delete')
    expect(finals(editor, CanvasAction.delete).at(-1)?.actionOutcome).toBe(ActionOutcome.unchanged)
    editor.set({ busy: true }); await dispatchEditorCommand(editor, 'paste')
    expect(finals(editor, CanvasAction.paste).at(-1)).toMatchObject({ actionOutcome: ActionOutcome.blocked, actionReason: ActionReason.busy })
  })
  it('finishes clipboard actions only after async result and preserves original on rejection', async () => {
    const editor = fresh(); const id = editor.add('rectangle', { x: 0, y: 0, width: 20, height: 20 })
    let reject!: (e: Error) => void
    ;(window as any).coreDesktop.clipboard.write = () => new Promise((_, fail) => { reject = fail })
    const pending = dispatchEditorCommand(editor, 'cut')
    expect(finals(editor, CanvasAction.cut)).toHaveLength(0)
    reject(new Error('DO_NOT_LOG_CLIPBOARD_ERROR')); await pending
    expect(editor.state.doc.nodes[id]).toBeDefined()
    expect(finals(editor, CanvasAction.cut).at(-1)?.actionOutcome).toBe(ActionOutcome.rejected)
    expect(JSON.stringify(canvasActions(editor).snapshot().rows)).not.toContain('DO_NOT_LOG_CLIPBOARD_ERROR')
  })
  it('activates eraser/frame, creates a frame, and observes page changes on an empty document', async () => {
    const editor = fresh()
    await dispatchEditorCommand(editor, 'set-tool-eraser'); expect(editor.state.tool).toBe('eraser')
    await dispatchEditorCommand(editor, 'set-tool-frame'); expect(editor.state.tool).toBe('frame')
    const frame = editor.add('frame', { x: 0, y: 0, width: 100, height: 100 })
    expect(editor.state.doc.nodes[frame].kind).toBe('frame')
    editor.addPage(); expect(editor.state.doc.pages).toHaveLength(2)
    expect(finals(editor, CanvasAction.page).at(-1)?.actionOutcome).toBe(ActionOutcome.committed)
    expect(finals(editor, CanvasAction.tool).at(-1)?.actionOutcome).toBe(ActionOutcome.observed)
  })
  it('gives every registered dispatcher command a nonzero category identifier', async () => {
    const editor = fresh(); editor.set({ busy: true })
    // Busy gate exercises actual routes without requesting clipboard, file or OS effects.
    for (const command of editorCommands.filter(c => !c.startsWith('set-tool-'))) {
      await dispatchEditorCommand(editor, command)
      expect(canvasActions(editor).snapshot().rows.at(-1)?.commandCode).toBe(editorCommands.indexOf(command) + 1)
    }
  })
  it('keeps grouping/order/lock/visibility and right-panel size edits undoable on a new canvas', async () => {
    const editor = fresh()
    const a = editor.add('rectangle', { x: 0, y: 0, width: 20, height: 30 })
    const b = editor.add('rectangle', { x: 40, y: 0, width: 20, height: 30 })
    editor.select([a]); await dispatchEditorCommand(editor, 'bring-to-front')
    expect(editor.state.doc.pages[0].children.at(-1)).toBe(a)
    await dispatchEditorCommand(editor, 'lock-selection'); expect(editor.state.doc.nodes[a].locked).toBe(true)
    await dispatchEditorCommand(editor, 'unlock-selection'); expect(editor.state.doc.nodes[a].locked).toBe(false)
    await dispatchEditorCommand(editor, 'hide-selection'); expect(editor.state.doc.nodes[a].visible).toBe(false)
    await dispatchEditorCommand(editor, 'show-selection'); expect(editor.state.doc.nodes[a].visible).toBe(true)
    editor.updateProperties([a], { width: 75, height: 85 })
    expect(editor.selectionBounds()).toMatchObject({ width: 75, height: 85 })
    expect(finals(editor, CanvasAction.layer).at(-1)).toMatchObject({ actionOutcome: ActionOutcome.committed, actionSource: 4 })
    editor.select([a, b]); await dispatchEditorCommand(editor, 'group')
    const group = editor.state.selection[0]; expect(editor.state.doc.nodes[group].children).toEqual([b, a])
    await dispatchEditorCommand(editor, 'ungroup'); expect(editor.state.doc.nodes[group]).toBeUndefined()
    await dispatchEditorCommand(editor, 'undo'); expect(editor.state.doc.nodes[group].children).toEqual([b, a])
  })
  it('reports a new document as observed in its adopted session, not a cross-session authored commit', () => {
    const editor = fresh(); editor.add('rectangle', { x: 0, y: 0, width: 10, height: 10 })
    editor.newDocument()
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
    expect(finals(editor, CanvasAction.newDocument).at(-1)).toMatchObject({ actionOutcome: ActionOutcome.observed, actionSession: editor.sessionGeneration })
  })
  it('aggregates a held keyboard nudge into one action and one undo', () => {
    const editor = fresh(); const id = editor.add('rectangle', { x: 0, y: 0, width: 10, height: 10 })
    const gesture = createKeyboardNudgeGesture(editor)
    const key = { key: 'ArrowRight', repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }
    gesture.step(key, '移动图层', () => editor.transformSelection([1, 0, 0, 1, 1, 0]))
    for (let i = 0; i < 5; i++) gesture.step({ ...key, repeat: true }, '移动图层', () => editor.transformSelection([1, 0, 0, 1, 1, 0]))
    expect(finals(editor, CanvasAction.move)).toHaveLength(0)
    gesture.release('ArrowRight'); expect(finals(editor, CanvasAction.move)).toHaveLength(1)
    expect(worldMatrix(editor.state.doc, id)[4]).toBe(6)
    editor.undo(); expect(worldMatrix(editor.state.doc, id)[4]).toBe(0)
    gesture.dispose()
  })

  it('does not attribute a concurrent edit to an awaited clipboard copy', async () => {
    const editor = fresh(); editor.add('rectangle', { x: 0, y: 0, width: 10, height: 10 })
    let complete!: (value: unknown) => void
    ;(window as any).coreDesktop.clipboard.write = () => new Promise(resolve => { complete = resolve })
    const copying = dispatchEditorCommand(editor, 'copy')
    editor.add('ellipse', { x: 20, y: 30, width: 10, height: 10 })
    complete({ status: 'ok' }); await copying
    expect(finals(editor, CanvasAction.copy).at(-1)).toMatchObject({ actionOutcome: ActionOutcome.observed, committedChanged: 0 })
  })

})
