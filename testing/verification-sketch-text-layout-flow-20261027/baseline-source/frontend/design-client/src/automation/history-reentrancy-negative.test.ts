import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()) })
for (const method of ['history.undo', 'history.redo'] as const) test.each(['different-id', 'same-id'] as const)(`${method}: %s load after history commit retains its owner and history facts`, replacement => {
  const doc = blank('Old history owner'), item = node('rectangle')
  doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
  const editor = new Editor(doc), api = createEditorDesignAutomation(editor)
  cleanups.push(() => editor.dispose(), () => api.dispose())
  editor.change('Before history request', d => { d.nodes[item.id].name = 'Changed' })
  if (method === 'history.redo') editor.undo()
  const owner = { documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }
  let entered = false, adopted!: Editor['state']
  const off = editor.subscribe(() => {
    if (entered || editor.state.version !== owner.expectedRevision + 1) return
    entered = true; const next = structuredClone(doc)
    if (replacement === 'different-id') next.id = crypto.randomUUID()
    next.name = 'PRIVATE_NEW_HISTORY_OWNER'; editor.load(next); editor.select([item.id]); adopted = editor.state
  }); cleanups.push(off)
  const response = api.execute({ method, ...owner })
  expect(response).toMatchObject({ ok: true, documentId: owner.documentId, session: owner.session, revision: owner.expectedRevision + 1 })
  if (!response.ok) throw Error(response.error.message)
  expect(response.result).toMatchObject({ noChange: false, canUndo: method === 'history.redo', canRedo: method === 'history.undo',
    completion: { status: 'committed', superseded: true, contextApplied: false, retry: 'do-not-retry', documentId: owner.documentId, session: owner.session, revision: owner.expectedRevision + 1 } })
  expect(entered).toBe(true); expect(editor.state).toBe(adopted)
  expect(JSON.stringify(response)).not.toContain('PRIVATE_NEW_HISTORY_OWNER')
})
