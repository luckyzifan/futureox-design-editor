import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Editor } from '../engine'
import { SaveCoordinator } from '../local-store'
import { blank } from '../model'
import { importFig } from '../import-fig'
import { import_sketch_json } from '../generated/design-kernel/design_kernel'
import { applyAgentOperations } from './apply-operations'
import { availableCompareFiles, missingCompareNames, readCompareFile } from './comparison-fixtures'
import { compareOutlines, outlineDocument, sketchRoundTripGaps } from './format-gap'

const bin = new URL('../../../../design-studio/target/debug/futureox-design-agent', import.meta.url)
const port = 39281
let child: ChildProcess | undefined
const editors: Editor[] = []

async function turn(message: string, context: Record<string, unknown>, session = crypto.randomUUID().replace(/-/g, '')) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session, message, context }),
  })
  const body = await response.json()
  expect(response.ok, JSON.stringify(body)).toBe(true)
  return body as { operations: Array<{ method: string; params: Record<string, unknown> }>; mutationId: string; summary: string; skills: string[]; targetPageId: string }
}

beforeAll(async () => {
  child = spawn(fileURLToPath(bin), ['serve', '--bind', `127.0.0.1:${port}`], { stdio: 'ignore' })
  const deadline = Date.now() + 8000
  let last = 'agent did not start'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(last)
})
afterAll(() => { child?.kill(); editors.splice(0).forEach(editor => editor.dispose()) })

test('a complete brief generates a real page, then a named page can be adjusted', async () => {
  const editor = new Editor(blank('比较'))
  editors.push(editor)
  const created = await turn('做一个咖啡品牌落地页，标题秋日特惠，副标题手冲咖啡本周上新，卖点：产地、烘焙、门店', {
    current_page_id: editor.state.page,
    target_page_id: editor.state.page,
    pages: editor.state.doc.pages.map(page => ({ id: page.id, name: page.name })),
    nodes: [],
  })
  expect(created.skills).toContain('one-click-generate')
  const applied = await applyAgentOperations(editor, created.operations, '一键出图', created.mutationId)
  expect(applied.ok, JSON.stringify(applied)).toBe(true)
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc.pages.some(page => page.name === '秋日特惠')).toBe(false)
  expect(editor.canRedo).toBe(true)
  editor.redo()
  const saver = new SaveCoordinator(async () => {})
  saver.open({ document: editor.state.doc, revision: 1, updatedAt: 1 }, 0)
  saver.observe(editor.state.doc, editor.state.version)
  expect(saver.dirty).toBe(true)
  const texts = Object.values(editor.state.doc.nodes).filter(node => node.kind === 'text').map(node => node.text)
  expect(texts).toContain('秋日特惠')
  expect(texts).toContain('产地')
  expect(editor.state.doc.pages.some(page => page.name === '秋日特惠')).toBe(true)

  const target = editor.state.doc.pages.find(page => page.name === '秋日特惠')!
  const nodes = Object.values(editor.state.doc.nodes).filter(node => {
    let at = node.id
    const parents = new Map<string, string>()
    for (const page of editor.state.doc.pages) for (const id of page.children) parents.set(id, page.id)
    const walk = (id: string, parent: string) => { parents.set(id, parent); editor.state.doc.nodes[id]?.children.forEach(child => walk(child, id)) }
    for (const page of editor.state.doc.pages) page.children.forEach(id => walk(id, page.id))
    while (parents.has(at) && !editor.state.doc.pages.some(page => page.id === parents.get(at))) at = parents.get(at)!
    return parents.get(node.id) === target.id || editor.state.doc.pages.some(page => page.id === target.id && page.children.includes(node.id)) || nodeBelongs(editor, node.id, target.id)
  })
  const adjusted = await turn('把秋日特惠页的标题改成暖季菜单', {
    current_page_id: editor.state.page,
    target_page_id: target.id,
    pages: editor.state.doc.pages.map(page => ({ id: page.id, name: page.name })),
    nodes: nodes.map(node => ({ id: node.id, page_id: target.id, parent_id: null, name: node.name, kind: node.kind, x: node.transform[4], y: node.transform[5], width: node.width, height: node.height, text: node.text })),
  })
  const edited = await applyAgentOperations(editor, adjusted.operations, '细节调整', adjusted.mutationId)
  expect(edited.ok, JSON.stringify(edited)).toBe(true)
  expect(Object.values(editor.state.doc.nodes).some(node => node.text === '暖季菜单')).toBe(true)
})

function nodeBelongs(editor: Editor, id: string, pageId: string) {
  const parents = new Map<string, string>()
  const visit = (nodeId: string, parent: string) => { parents.set(nodeId, parent); editor.state.doc.nodes[nodeId]?.children.forEach(child => visit(child, nodeId)) }
  for (const page of editor.state.doc.pages) page.children.forEach(child => visit(child, page.id))
  let at = id
  while (parents.has(at)) at = parents.get(at)!
  return at === pageId
}

test('generated page is compared with a real Fig file and a real Sketch template', async () => {
  const editor = new Editor(blank('比较'))
  editors.push(editor)
  const created = await turn('一键出图：做一个产品介绍页，标题秋日特惠，副标题可编辑页面，卖点：层级、修改、本地', {
    current_page_id: editor.state.page, target_page_id: editor.state.page,
    pages: [{ id: editor.state.page, name: '页面 1' }], nodes: [],
  })
  expect((await applyAgentOperations(editor, created.operations, '一键出图', created.mutationId)).ok).toBe(true)
  const current = outlineDocument(editor.state.doc)
  expect(current.pages.some(page => page.texts.includes('秋日特惠'))).toBe(true)

  const repoFigs = [
    new URL('../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data', import.meta.url).pathname,
  ]
  const present = availableCompareFiles(repoFigs)
  expect(present.some(file => file.path.endsWith('.fig'))).toBe(true)
  const sectionsUrl = new URL('../../../../testing/fixtures/fig-tools-public-20261106/fig2sketch/tests/data/sections.fig', import.meta.url)
  const sample = existsSync(sectionsUrl)
    ? { name: 'sections.fig', bytes: readFileSync(sectionsUrl) }
    : (() => { const file = present.find(item => item.path.endsWith('sections.fig')) || present.find(item => item.path.endsWith('.fig'))!; return { name: file.name, bytes: readCompareFile(file.path) } })()
  const fig = importFig(sample.bytes, sample.name)
  const figGaps = compareOutlines(current, outlineDocument(fig.document), sample.name)
  expect(figGaps.some(gap => gap.detail.includes('秋日特惠'))).toBe(true)
  expect(fig.document.pages.length).toBeGreaterThan(0)
  const sketchPath = present
    .filter(file => file.path.endsWith('.sketch'))
    .map(file => ({ ...file, size: statSync(file.path).size }))
    .filter(file => file.size < 2_000_000)
    .sort((a, b) => a.size - b.size)[0]
  if (sketchPath) {
    try {
      const sketch = JSON.parse(import_sketch_json(readCompareFile(sketchPath.path))).document
      const sketchGaps = compareOutlines(current, outlineDocument(sketch), sketchPath.name)
      expect(sketchGaps.length).toBeGreaterThan(0)
    } catch (error) {
      expect(String(error)).toMatch(/Limit|rejected|codec|不支持/)
    }
  }
  const absent = missingCompareNames(present)
  expect(absent.includes('01有料素材.fig') || present.some(file => file.name.includes('有料素材'))).toBe(true)

  const round = sketchRoundTripGaps(editor.state.doc)
  expect(round.warnings.length + round.gaps.length).toBeGreaterThan(0)
})
