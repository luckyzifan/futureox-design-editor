import { describe, expect, test } from 'vitest'
import { CanvasOperationDiagnostics } from './canvas-operation-diagnostics'
import { Editor } from './engine'
import { blank, node } from './model'

function fixture() {
  const document = blank('SECRET DOCUMENT'), a = node('rectangle', 10, 20, 40, 30)
  a.name = 'SECRET NAME'; document.nodes[a.id] = a; document.pages[0].children = [a.id]
  const editor = new Editor(document); editor.select([a.id]); editor.operationDiagnostics.enableDetail(true)
  return { editor, id: a.id }
}
function present(editor: Editor, document = editor.state.doc, epoch = editor.sessionGeneration, preview = false) {
  editor.observeCanvasPresentation({ document, epoch, pageId: editor.state.page, preview })
}
const last = (editor: Editor) => editor.operationDiagnostics.snapshot().records.at(-1)!
describe('operation expectations at shared editor boundaries', () => {
  test('cancelled drag never claims committed or presented success', () => {
    const { editor, id } = fixture()
    try {
      const before = editor.state.doc
      editor.begin('移动图层'); editor.preview({ [id]: { transform: [1, 0, 0, 1, 30, 40] } })
      const preview = editor.state.doc; present(editor, preview)
      editor.cancel(); present(editor); present(editor, preview)
      expect(editor.state.doc).toBe(before)
      expect(last(editor)).toMatchObject({ category: 'move', outcome: 'cancelled', authoredRevision: null, previewAttempts: 1, previewAccepted: 1, presentation: 'unobserved' })
    } finally { editor.dispose() }
  })
  test('committed resize requires matching session and exact snapshot, then undo has independent revision', () => {
    const { editor, id } = fixture()
    try {
      const before = editor.state.doc
      editor.begin('缩放图层'); editor.preview({ [id]: { width: 80 } }); editor.commit()
      const committed = editor.state.doc, revision = editor.state.version
      expect(last(editor)).toMatchObject({ category: 'resize', outcome: 'committed', authoredRevision: revision, presentation: 'unobserved' })
      present(editor, before); present(editor, committed, editor.sessionGeneration + 1); present(editor, committed, editor.sessionGeneration, true)
      expect(last(editor).presentation).toBe('unobserved')
      present(editor)
      expect(last(editor).presentation).toBe('exact-snapshot-acknowledged')
      editor.undo(); present(editor, committed)
      expect(last(editor)).toMatchObject({ category: 'undo', authoredRevision: revision + 1, presentation: 'unobserved' })
      present(editor); expect(last(editor).presentation).toBe('exact-snapshot-acknowledged')
      editor.redo(); present(editor); expect(last(editor).category).toBe('redo')
    } finally { editor.dispose() }
  })
  test('text and property changes expose category/counts, never content; unchanged and rejection are explicit', () => {
    const { editor, id } = fixture()
    try {
      editor.update([id], n => { n.name = 'SECRET TEXT' }, '编辑文字')
      expect(last(editor)).toMatchObject({ category: 'text', targetCount: 1, outcome: 'committed' })
      editor.updateProperties([id], { name: 'SECRET PROPERTY' })
      expect(last(editor)).toMatchObject({ category: 'property', outcome: 'committed' })
      editor.updateProperties([id], { name: 'SECRET PROPERTY' })
      expect(last(editor).outcome).toBe('unchanged')
      editor.change('SECRET LABEL', () => { throw new Error('SECRET ERROR') })
      expect(last(editor).outcome).toBe('rejected')
      const serialized = JSON.stringify(editor.operationDiagnostics.snapshot())
      expect(serialized).not.toContain('SECRET'); expect(serialized).not.toContain(id)
    } finally { editor.dispose() }
  })
  test('rich text callback commits are categorized without retaining text', () => {
    const document = blank(), text = node('text', 0, 0, 200, 40)
    document.nodes[text.id] = text; document.pages[0].children = [text.id]
    const editor = new Editor(document); editor.operationDiagnostics.enableDetail(true)
    try {
      editor.update([text.id], n => { n.text = 'PRIVATE RICH TEXT'; n.textRuns = [] }, '编辑富文本')
      expect(editor.state.doc.nodes[text.id].text).toBe('PRIVATE RICH TEXT')
      expect(last(editor)).toMatchObject({ category: 'text', outcome: 'committed', presentation: 'unobserved' })
      expect(JSON.stringify(editor.operationDiagnostics.snapshot())).not.toContain('PRIVATE')
    } finally { editor.dispose() }
  })
  test('document replacement retires pending acknowledgements', () => {
    const { editor, id } = fixture()
    try {
      editor.updateProperties([id], { width: 90 })
      const old = editor.state.doc, epoch = editor.sessionGeneration
      editor.load(blank()); present(editor, old, epoch)
      expect(editor.operationDiagnostics.snapshot().pendingCount).toBe(0)
      expect(last(editor).presentation).toBe('unobserved')
    } finally { editor.dispose() }
  })
})
test('bounded opt-in ring, aggregate-only default, no duplicate acknowledgement or terminal writes', () => {
  const diagnostics = new CanvasOperationDiagnostics(3), document = {}
  let op = diagnostics.begin(0, 0, 'property', 1)
  diagnostics.finish(op, 'committed', 0, 1, document, 'SECRET PAGE')
  expect(diagnostics.snapshot().records).toEqual([])
  diagnostics.enableDetail(true)
  for (let i = 0; i < 20; i++) {
    op = diagnostics.begin(0, i, 'move', 1)
    for (let j = 0; j < 100; j++) diagnostics.preview(op, true)
    diagnostics.finish(op, 'committed', 0, i + 1, document, 'SECRET PAGE')
  }
  expect(diagnostics.snapshot().records).toHaveLength(3)
  expect(diagnostics.snapshot().pendingCount).toBe(3)
  diagnostics.acknowledge(0, 20, document, 'SECRET PAGE', false)
  diagnostics.acknowledge(0, 20, document, 'SECRET PAGE', false)
  expect(diagnostics.snapshot().totals.exactAcknowledged).toBe(1)
  expect(diagnostics.snapshot().totals.evictedUnobserved).toBe(18)
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain('SECRET')
  diagnostics.enableDetail(false); expect(diagnostics.snapshot().records).toEqual([])
})
