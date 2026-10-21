import { expect, test, vi } from 'vitest'
import * as arrangement from './arrangement-plan'
import { readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from '../automation/index'
import { DesignAutomationApi } from '../automation/core'
import { fileURLToPath } from 'node:url'
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
test('planners do not import Editor, renderer, native picking, protocol or model runtime', () => {
  for (const file of ['affine.ts', 'profiles.ts', 'arrangement-plan.ts', 'structure-plan.ts', 'apply-plan.ts']) {
    const source = read(file)
    const runtimeImports = [...source.matchAll(/^import (?!type\b).*from ['"]([^'"]+)['"]/gm)].map(match => match[1])
    expect(runtimeImports.every(path => ['./affine', './arrangement-plan', './structure-plan', './profiles'].includes(path))).toBe(true)
    expect(source).not.toMatch(/\b(?:Date\.now|Math\.random|crypto\.|window\.|document\.|fetch\(|new Editor\(|uid\()/)
  }
})
test('UI, arrange helpers and automation call one selection-command contract, never UI-to-MCP dispatch', () => {
  for (const file of ['../engine.ts', '../align-engine.ts', '../automation/core.ts']) expect(read(file)).toContain('prepareSelectionArrangement(')
  for (const file of ['../engine.ts', '../automation/core.ts']) {
    expect(read(file)).toContain('prepareSelectionWrap('); expect(read(file)).toContain('applySelectionUnwrap(')
  }
  expect(read('../automation/core.ts')).not.toMatch(/\.group\(|\.ungroup\(|\.align\(/)
  expect(read('../engine.ts')).not.toContain('createDesignAutomation')
  expect(read('profiles.ts')).not.toMatch(/ui-selection-v1|automation-v1/)
})

test('runtime registry resolves the exact materialized candidate core and Editor', () => {
  const editor = new Editor(blank()), api = createEditorDesignAutomation(editor)
  try {
    expect(api).toBeInstanceOf(DesignAutomationApi); expect(api.editor.constructor).toBe(Editor)
    const records = ['../engine.ts', '../automation/core.ts', '../automation/index.ts'].map(relative => {
      const path = fileURLToPath(new URL(relative, import.meta.url)), canonicalPath = realpathSync(path)
      expect(lstatSync(path).isSymbolicLink()).toBe(false); expect(canonicalPath).toBe(path)
      return { path, canonicalPath, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
    })
    if (process.env.FUTUREOX_MODULE_IDENTITY_RECORD) writeFileSync(process.env.FUTUREOX_MODULE_IDENTITY_RECORD, JSON.stringify(records, null, 2) + '\n')
  } finally { api.dispose(); editor.dispose() }
})


test('actual UI and registry adapters both execute the candidate arrangement planner', () => {
  const document = blank(), parent = node('frame', 0, 0, 300, 300), child = node('rectangle', 30, 40, 20, 20)
  parent.children = [child.id]; document.nodes = { [parent.id]: parent, [child.id]: child }; document.pages[0].children = [parent.id]
  const editor = new Editor(document), api = createEditorDesignAutomation(editor), planner = vi.spyOn(arrangement, 'planArrangement')
  try {
    editor.select([child.id]); editor.align('x', 'start')
    expect(planner).toHaveBeenCalled(); planner.mockClear()
    expect(api.execute({ method: 'node.align', params: { ids: [child.id], axis: 'y', mode: 'start' },
      documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }).ok).toBe(true)
    expect(planner).toHaveBeenCalled()
  } finally { planner.mockRestore(); api.dispose(); editor.dispose() }
})
