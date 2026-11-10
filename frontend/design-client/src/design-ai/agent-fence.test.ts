import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, uid } from '../model'
import { agentFence, applyAgentOperations, explainApplyFailure } from './apply-operations'

function titled(text = 'QA_ORIGINAL') {
  const doc = blank('QA')
  doc.pages[0].name = 'Target QA'
  const frame = node('frame', 0, 0, 240, 140)
  frame.name = '画板'
  const title = node('text', 16, 16, 180, 36)
  title.name = '标题'
  title.text = text
  frame.children = [title.id]
  doc.nodes[frame.id] = frame
  doc.nodes[title.id] = title
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  const live = Object.values(editor.state.doc.nodes).find(item => item.name === '标题')!
  const board = Object.values(editor.state.doc.nodes).find(item => item.name === '画板')!
  return { editor, titleId: live.id, frameId: board.id }
}

const readTitle = (editor: Editor) => Object.values(editor.state.doc.nodes).find(item => item.name === '标题')?.text

const replace = (id: string, previous: string, text: string) => [{
  method: 'text.replaceRange',
  params: { nodeId: id, start: 0, end: previous.length, text, expectedText: previous },
}]

test('a late assistant batch keeps the manual title and one undo removes only that manual edit', async () => {
  const { editor, titleId } = titled()
  const fence = agentFence(editor)
  editor.change('手动', draft => { draft.nodes[titleId].text = 'MANUAL_NEW_TITLE' })
  const applied = await applyAgentOperations(editor, replace(titleId, 'QA_ORIGINAL', 'AI_OLD_RESULT'), '细节调整', 'agent-stale-manual', fence)
  expect(applied.ok).toBe(false)
  expect(applied.error?.code).toBe('stale_revision')
  expect(explainApplyFailure(applied.error)).toContain('没有写入')
  expect(readTitle(editor)).toBe('MANUAL_NEW_TITLE')
  expect(JSON.stringify(editor.state.doc)).not.toContain('AI_OLD_RESULT')
  const saved = JSON.parse(JSON.stringify(editor.state.doc)) as ReturnType<typeof blank>
  editor.undo()
  expect(readTitle(editor)).toBe('QA_ORIGINAL')
  const reopened = new Editor(saved)
  expect(readTitle(reopened)).toBe('MANUAL_NEW_TITLE')
  reopened.dispose()
  editor.dispose()
})

test('undo, redo, document replacement and a same-revision page switch keep the request fence', async () => {
  const { editor, titleId } = titled()
  editor.change('手动', draft => { draft.nodes[titleId].text = 'MANUAL_NEW_TITLE' })
  const beforeUndo = agentFence(editor)
  editor.undo()
  const undone = await applyAgentOperations(editor, replace(titleId, 'MANUAL_NEW_TITLE', 'AI_OLD_RESULT'), '细节调整', 'agent-after-undo', beforeUndo)
  expect(undone.ok).toBe(false)
  expect(readTitle(editor)).toBe('QA_ORIGINAL')
  editor.redo()
  expect(readTitle(editor)).toBe('MANUAL_NEW_TITLE')

  const pageId = uid()
  editor.change('加页', draft => { draft.pages.push({ id: pageId, name: '另一页', children: [], background: '#ffffff' }) })
  const beforeSwitch = agentFence(editor)
  expect(editor.switchPage(pageId)).toBe(true)
  expect(editor.state.version).toBe(beforeSwitch.revision)
  const switched = await applyAgentOperations(editor, replace(titleId, 'MANUAL_NEW_TITLE', 'AI_AFTER_SWITCH'), '细节调整', 'agent-after-switch', beforeSwitch)
  expect(switched.ok).toBe(true)
  expect(readTitle(editor)).toBe('AI_AFTER_SWITCH')
  editor.undo()
  expect(readTitle(editor)).toBe('MANUAL_NEW_TITLE')

  const beforeLoad = agentFence(editor)
  expect(editor.load(blank('换过的文档'))).toBe(true)
  const replaced = await applyAgentOperations(editor, replace(titleId, 'MANUAL_NEW_TITLE', 'AI_OLD_RESULT'), '细节调整', 'agent-after-load', beforeLoad)
  expect(replaced.ok).toBe(false)
  expect(['document_mismatch', 'session_mismatch']).toContain(replaced.error?.code)
  expect(editor.state.doc.name).toBe('换过的文档')
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})
