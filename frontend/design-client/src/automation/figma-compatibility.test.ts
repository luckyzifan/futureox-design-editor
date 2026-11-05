import { expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { createEditorDesignAutomation } from './index'
// @ts-expect-error The dependency-free stdio adapter is native JavaScript.
import { FigmaFacade } from '../../../design-mcp/src/figma-facade.mjs'
import type { AutomationRequest } from './types'

it('compiles new and sequentially moved layers on the same draft and exports code through the strict real registry', async () => {
  const editor = new Editor(blank('Local MCP'))
  const api = createEditorDesignAutomation(editor)
  const facade = new FigmaFacade({ methods: api.methods(), execute: (request: AutomationRequest) => api.execute(request) })
  const id = crypto.randomUUID()
  const edits = (operations: object[]) => facade.callTool('use_figma', { description: 'Place a card', operations })
  try {
    const result = await edits([
      { op: 'create', id, kind: 'rectangle', name: 'MCP card', x: 10, y: 20 },
      { op: 'update', nodeId: id, x: 100 }, { op: 'update', nodeId: id, y: 200 },
      { op: 'select', nodeIds: [id] },
    ])
    expect(result).toMatchObject({ ok: true, revision: 1 })
    expect(editor.state.doc.nodes[id].transform).toEqual([1, 0, 0, 1, 100, 200])
    for (const args of [{ nodeId: id }, {}]) {
      const value = await facade.callTool('get_design_context', args)
      expect(value.result).toMatchObject({ format: 'futureox.design-code.v1', html: expect.stringContaining(id), css: expect.any(String) })
      expect(value.result.css.length).toBeGreaterThan(0)
      expect(value.result.codeExportError).toBeUndefined()
    }
    const revision = editor.state.version
    expect(await edits([{ op: 'update', nodeId: id, x: 99 }, { op: 'delete', nodeId: crypto.randomUUID() }])).toMatchObject({ ok: false })
    expect(editor.state.version).toBe(revision)
    expect(editor.state.doc.nodes[id].transform[4]).toBe(100)
    expect(api.execute({ method: 'history.undo', params: {}, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: revision }).ok).toBe(true)
    expect(editor.state.doc.nodes[id]).toBeUndefined()
  } finally { api.dispose(); editor.dispose() }
})
