import { afterEach, expect, test } from 'vitest'
import { readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
import { DesignAutomationApi } from './core'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()) })
test('ordinary mutation, no-op and exact retry keep the existing serialized response shape', () => {
  const doc = blank('Stable shape'); doc.id = '11111111-1111-4111-8111-111111111111'
  doc.pages[0].id = '22222222-2222-4222-8222-222222222222'
  const item = node('rectangle'); item.id = '33333333-3333-4333-8333-333333333333'
  item.fills[0].id = '44444444-4444-4444-8444-444444444444'
  doc.nodes = { [item.id]: item }; doc.pages[0].children = [item.id]
  const editor = new Editor(doc); editors.push(editor)
  const api = createEditorDesignAutomation(editor)
  expect(api).toBeInstanceOf(DesignAutomationApi); expect(api.editor.constructor).toBe(Editor)
  const records = ['../engine.ts', './core.ts', './index.ts'].map(relative => {
    const path = fileURLToPath(new URL(relative, import.meta.url)), canonicalPath = realpathSync(path)
    expect(lstatSync(path).isSymbolicLink()).toBe(false); expect(canonicalPath).toBe(path)
    return { path, canonicalPath, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
  if (process.env.FUTUREOX_MODULE_IDENTITY_RECORD) writeFileSync(process.env.FUTUREOX_MODULE_IDENTITY_RECORD, JSON.stringify(records, null, 2) + '\n')
  try {
    const request = { id: 'shape', method: 'batch.apply', documentId: doc.id, session: editor.sessionGeneration, expectedRevision: 0,
      params: { mutationId: 'shape', operations: [{ method: 'node.update', params: { ids: [item.id], patch: { name: 'Renamed' } } }] } }
    const committed = api.execute(request), retry = api.execute(request)
    const noOp = api.execute({ method: 'node.update', documentId: doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version,
      params: { ids: [item.id], patch: { name: 'Renamed' } } })
    for (const response of [committed, retry, noOp]) {
      expect(response.ok, JSON.stringify(response)).toBe(true)
      if (response.ok) {
        expect(response.result).not.toHaveProperty('completion')
        expect(response.result).not.toHaveProperty('receipt.replayAvailable')
      }
    }
    const serialized = JSON.stringify({ committed, retry, noOp }, null, 2) + '\n'
    if (process.env.FUTUREOX_MUTATE_SHAPE_RECORD) writeFileSync(process.env.FUTUREOX_MUTATE_SHAPE_RECORD, serialized)
  } finally { api.dispose() }
})


test('ordinary history no-op, undo and redo keep the existing serialized response shape', () => {
  const doc = blank('Stable history shape'); doc.id = '11111111-1111-4111-8111-111111111111'
  doc.pages[0].id = '22222222-2222-4222-8222-222222222222'
  const item = node('rectangle'); item.id = '33333333-3333-4333-8333-333333333333'
  item.fills[0].id = '44444444-4444-4444-8444-444444444444'
  doc.nodes = { [item.id]: item }; doc.pages[0].children = [item.id]
  const editor = new Editor(doc); editors.push(editor)
  const api = createEditorDesignAutomation(editor)
  const call = (method: string) => api.execute({ method, documentId: doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  try {
    const noOp = call('history.undo')
    editor.change('Before undo', draft => { draft.nodes[item.id].name = 'Changed' })
    const undo = call('history.undo'), redo = call('history.redo')
    for (const response of [noOp, undo, redo]) {
      expect(response.ok, JSON.stringify(response)).toBe(true)
      if (response.ok) expect(response.result).not.toHaveProperty('completion')
    }
    if (process.env.FUTUREOX_HISTORY_SHAPE_RECORD) writeFileSync(process.env.FUTUREOX_HISTORY_SHAPE_RECORD, JSON.stringify({ noOp, undo, redo }, null, 2) + '\n')
  } finally { api.dispose() }
})
