import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
// @ts-expect-error The Electron host is shipped as a JavaScript module.
import { createDesignAgentHost, resolveDesignAgentBinary } from '../../../design-desktop/src/design-agent-host.mjs'
import { Editor } from '../engine'
import { SaveCoordinator } from '../local-store'
import { blank } from '../model'
import { importFig } from '../import-fig'
import { import_sketch_json } from '../generated/design-kernel/design_kernel'
import { agentFence, applyAgentOperations } from './apply-operations'
import { availableCompareFiles, missingCompareNames, readCompareFile } from './comparison-fixtures'
import { compareOutlines, outlineDocument, sketchRoundTripGaps } from './format-gap'

const packagedBin = resolveDesignAgentBinary({ resourcesRoot: fileURLToPath(new URL('../../../design-desktop/dist', import.meta.url)) })
const binaryName = process.platform === 'win32' ? 'futureox-design-agent.exe' : 'futureox-design-agent'
const cargoBin = fileURLToPath(new URL(`../../../../design-studio/target/debug/${binaryName}`, import.meta.url))
const bin = process.env.DESIGN_AGENT_BIN || [packagedBin, cargoBin].find(existsSync)
const agentTest = test.skipIf(!bin)
type AgentTurn = { operations: Array<{ method: string; params: Record<string, unknown> }>; mutationId: string; summary: string; skills: string[]; targetPageId: string }
let host: {
  turn(value: { session_id: string; message: string; context: Record<string, unknown> }): Promise<
    { status: 'ok'; turn: AgentTurn } | { status: 'error'; message: string }>
  dispose(): void
} | undefined
const editors: Editor[] = []

async function turn(message: string, context: Record<string, unknown>, session = crypto.randomUUID().replace(/-/g, '')) {
  const response = await host!.turn({ session_id: session, message, context })
  if (response.status === 'error') throw Error(response.message)
  return response.turn
}

beforeAll(async () => {
  if (!bin) return
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(Error('No loopback address')))
    })
  })
  // Exercise the same process ownership and HTTP route as Electron, in local mode.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  host = createDesignAgentHost({ bin, port, env })
})
afterAll(() => { host?.dispose(); editors.splice(0).forEach(editor => editor.dispose()) })

agentTest('a complete brief generates a real page, then a named page can be adjusted', async () => {
  const editor = new Editor(blank('比较'))
  editors.push(editor)
  const created = await turn('做一个咖啡品牌落地页，标题秋日特惠，副标题手冲咖啡本周上新，卖点：产地、烘焙、门店', {
    current_page_id: editor.state.page,
    target_page_id: editor.state.page,
    pages: editor.state.doc.pages.map(page => ({ id: page.id, name: page.name })),
    nodes: [],
  })
  expect(created.skills).toContain('one-click-generate')
  const applied = await applyAgentOperations(editor, created.operations, '一键出图', created.mutationId, agentFence(editor))
  expect(applied.ok, JSON.stringify(applied)).toBe(true)
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc.pages.some(page => page.name === '秋日特惠')).toBe(false)
  expect(editor.canRedo).toBe(true)
  editor.redo()
  const saver = new SaveCoordinator(async document => ({ document, revision: 1, updatedAt: 1 }))
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
  const edited = await applyAgentOperations(editor, adjusted.operations, '细节调整', adjusted.mutationId, agentFence(editor))
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

agentTest('generated page is compared with a real Fig file and a real Sketch template', async () => {
  const editor = new Editor(blank('比较'))
  editors.push(editor)
  const created = await turn('一键出图：做一个产品介绍页，标题秋日特惠，副标题可编辑页面，卖点：层级、修改、本地', {
    current_page_id: editor.state.page, target_page_id: editor.state.page,
    pages: [{ id: editor.state.page, name: '页面 1' }], nodes: [],
  })
  expect((await applyAgentOperations(editor, created.operations, '一键出图', created.mutationId, agentFence(editor))).ok).toBe(true)
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
