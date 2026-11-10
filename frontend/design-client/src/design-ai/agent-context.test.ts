import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, uid, type DesignNode, type Kind } from '../model'
import { AGENT_CONTEXT_NODE_LIMIT, snapshotContext } from './agent-client'

const editors: Editor[] = []
const done = (editor: Editor) => { editors.push(editor); return editor }

function chain(doc: ReturnType<typeof blank>, pageId: string, steps: Array<{ kind: Kind; name: string; text?: string }>) {
  let parent: DesignNode | undefined
  let leaf = ''
  const page = doc.pages.find(item => item.id === pageId)!
  for (const step of steps) {
    const item = node(step.kind, 0, 0, 120, 40)
    item.name = step.name
    if (step.text !== undefined) item.text = step.text
    doc.nodes[item.id] = item
    if (parent) parent.children.push(item.id)
    else page.children.push(item.id)
    parent = item
    leaf = item.id
  }
  return leaf
}

test('a later target page is sampled before earlier pages, within 64 nodes', () => {
  const doc = blank('多页')
  for (let index = 0; index < 70; index += 1) {
    const shape = node('rectangle', index, 0, 8, 8)
    shape.name = `矩形 ${index}`
    doc.nodes[shape.id] = shape
    doc.pages[0].children.push(shape.id)
  }
  const page = { id: uid(), name: 'Target QA', children: [] as string[], background: '#ffffff' }
  doc.pages.push(page)
  const titleId = chain(doc, page.id, [
    { kind: 'frame', name: '画板' },
    { kind: 'text', name: '标题', text: 'QA_ORIGINAL' },
  ])
  const editor = done(new Editor(doc))
  const target = editor.state.doc.pages.find(item => item.name === 'Target QA')!.id
  const liveTitle = Object.values(editor.state.doc.nodes).find(item => item.text === 'QA_ORIGINAL')!
  const context = snapshotContext(editor, target, '把标题改成 QA_NEW_TITLE')
  expect(context.nodes.length).toBeLessThanOrEqual(AGENT_CONTEXT_NODE_LIMIT)
  expect(context.nodes.length).toBe(AGENT_CONTEXT_NODE_LIMIT)
  expect(context.target_page_id).toBe(target)
  expect(context.nodes.some(item => item.id === liveTitle.id || item.id === titleId)).toBe(true)
  expect(context.nodes.filter(item => item.page_id === target).length).toBeGreaterThan(0)
  expect(context.omissions.some(item => item.includes('标题没有全部'))).toBe(false)
  editor.dispose()
})

test('a title nested under three groups is inside the bounded context', () => {
  const doc = blank('深层')
  const titleId = chain(doc, doc.pages[0].id, [
    { kind: 'frame', name: '画板' },
    { kind: 'group', name: '组 1' },
    { kind: 'group', name: '组 2' },
    { kind: 'group', name: '组 3' },
    { kind: 'text', name: '标题', text: 'QA_ORIGINAL' },
  ])
  const editor = done(new Editor(doc))
  const context = snapshotContext(editor, editor.state.page, '把标题改成 QA_NEW_TITLE')
  expect(context.nodes.length).toBeLessThanOrEqual(AGENT_CONTEXT_NODE_LIMIT)
  expect(context.nodes.map(item => item.id)).toContain(titleId)
  expect(context.nodes.filter(item => item.kind === 'group')).toHaveLength(3)
  expect(context.omissions.some(item => item.includes('标题没有全部'))).toBe(false)
  editor.dispose()
})

test('titles past the 64 node bound are reported omitted instead of treated as absent', () => {
  const doc = blank('很多标题')
  const ids: string[] = []
  for (let index = 0; index < 65; index += 1) {
    const title = node('text', 0, index * 20, 80, 16)
    title.name = '标题'
    title.text = `标题 ${index}`
    doc.nodes[title.id] = title
    doc.pages[0].children.push(title.id)
    ids.push(title.id)
  }
  const editor = done(new Editor(doc))
  const context = snapshotContext(editor, editor.state.page, '把标题改成 QA_NEW_TITLE')
  expect(context.nodes).toHaveLength(AGENT_CONTEXT_NODE_LIMIT)
  expect(context.nodes.some(item => item.id === ids[64])).toBe(false)
  expect(context.omissions.some(item => item.includes('标题') && item.includes('省略'))).toBe(true)
  editor.dispose()
})
