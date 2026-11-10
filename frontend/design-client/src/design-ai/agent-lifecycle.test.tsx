// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, uid } from '../model'
import type { DesktopBridge } from '../desktop'
import DesignAgentPanel from './DesignAgentPanel'
import { DesignAgentDock } from './DesignAgentDock'
import { openAgentDock, resetAgentDockForTests } from './design-agent-dock'

let root: Root | undefined
const editors: Editor[] = []
beforeEach(() => {
  Element.prototype.scrollTo = () => {}
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  }
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  resetAgentDockForTests()
  editors.splice(0).forEach(editor => editor.dispose())
})

type TurnBody = Record<string, unknown>
function host(turn: (body: TurnBody) => Promise<unknown> | unknown, cancel: (sessionId: string) => void = () => {}) {
  return {
    designAgent: {
      async status() { return { status: 'ok' as const, providers: [] } },
      async turn(body: unknown) { return { status: 'ok' as const, turn: await turn(body as TurnBody) } },
      async upsert() { return { status: 'ok' as const } },
      async activate() { return { status: 'ok' as const } },
      async remove() { return { status: 'ok' as const } },
      async cancel(body: { sessionId: string }) { cancel(body.sessionId); return { status: 'ok' as const } },
    },
  } as unknown as DesktopBridge
}

function quietTurn(body: TurnBody, assistant = 'api') {
  const context = body.context as { target_page_id?: string }
  return {
    sessionId: body.session_id, skills: ['detail-adjust'], assistant, summary: '收到',
    mutationId: 'agent-quiet', targetPageId: context.target_page_id, operations: [],
    items: [
      { type: 'UserMessage', id: 'user-1', text: body.message },
      { type: 'AgentMessage', id: 'agent-1', text: '收到', phase: 'Final' },
    ],
  }
}

async function typeInto(selector: string, value: string) {
  const field = document.querySelector(selector) as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === label) as HTMLButtonElement
  await act(async () => { button.click() })
}

function titledEditor() {
  const doc = blank('QA')
  doc.pages[0].name = 'Target QA'
  const frame = node('frame', 0, 0, 220, 120)
  frame.name = '画板'
  const title = node('text', 12, 12, 160, 32)
  title.name = '标题'
  title.text = 'QA_ORIGINAL'
  frame.children = [title.id]
  doc.nodes[frame.id] = frame
  doc.nodes[title.id] = title
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  editors.push(editor)
  const titleId = Object.values(editor.state.doc.nodes).find(item => item.name === '标题')!.id
  const frameId = Object.values(editor.state.doc.nodes).find(item => item.name === '画板')!.id
  return { editor, titleId, frameId }
}

const titleText = (editor: Editor) => Object.values(editor.state.doc.nodes).find(item => item.name === '标题')?.text

test('the global assistant follows the document that was just opened', async () => {
  const first = blank('旧文件')
  first.pages[0].name = '旧页面'
  const editor = new Editor(first)
  editors.push(editor)
  const calls: TurnBody[] = []
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={host(body => { calls.push(body); return quietTurn(body) })} onClose={() => {}} />) })
  expect(document.querySelector('.design-agent-target')!.getAttribute('data-target-page')).toBe(editor.state.page)
  expect(document.querySelector('.design-agent-target')!.textContent).toContain('旧页面')
  const next = blank('新文件')
  next.pages[0].name = 'Target QA'
  await act(async () => { editor.load(next) })
  const target = document.querySelector('.design-agent-target')!
  expect(target.getAttribute('data-target-page')).toBe(editor.state.page)
  expect(target.textContent).toContain('默认改「Target QA」')
  expect(target.textContent).not.toContain('旧页面')
  await typeInto('textarea', '细节调整：把标题改成 QA_NEW_TITLE')
  await clickButton('发送')
  const context = calls.at(-1)!.context as { target_page_id: string; current_page_id: string; pages: Array<{ id: string }> }
  expect(context.target_page_id).toBe(editor.state.page)
  expect(context.current_page_id).toBe(editor.state.page)
  expect(context.pages.some(page => page.id === context.target_page_id)).toBe(true)
})

test('a page-row target survives navigation and is dropped when that page leaves the document', async () => {
  const doc = blank('两页')
  const second = { id: uid(), name: 'Target QA', children: [] as string[], background: '#ffffff' }
  doc.pages.push(second)
  const editor = new Editor(doc)
  editors.push(editor)
  const pageId = editor.state.doc.pages.find(page => page.name === 'Target QA')!.id
  const calls: TurnBody[] = []
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => {
    root!.render(<DesignAgentPanel editor={editor} desktop={host(body => { calls.push(body); return quietTurn(body) })} onClose={() => {}} initial={{ pageId, prompt: '细节调整：把标题改成 QA_NEW_TITLE', send: false }} />)
  })
  expect(document.querySelector('.design-agent-target')!.getAttribute('data-target-page')).toBe(pageId)
  await act(async () => { editor.switchPage(editor.state.doc.pages[0].id) })
  expect(document.querySelector('.design-agent-target')!.getAttribute('data-target-page')).toBe(pageId)
  const opened = blank('导入副本')
  opened.pages[0].name = '副本页'
  await act(async () => { editor.load(opened) })
  expect(document.querySelector('.design-agent-target')!.getAttribute('data-target-page')).toBe(editor.state.page)
  expect(document.querySelector('.design-agent-target')!.textContent).toContain('副本页')
  await clickButton('发送')
  const context = calls.at(-1)!.context as { target_page_id: string }
  expect(context.target_page_id).toBe(editor.state.page)
  expect(context.target_page_id).not.toBe(pageId)
})

test('a newer manual edit rejects the assistant result that was already in flight', async () => {
  const { editor, titleId, frameId } = titledEditor()
  let release: (value: unknown) => void = () => {}
  const pending = new Promise(resolve => { release = resolve })
  const desktop = host(body => {
    editor.change('手动', draft => { draft.nodes[frameId].name = '改过的画板' })
    return pending.then(() => ({
      sessionId: body.session_id, skills: ['detail-adjust'], assistant: 'api', summary: '标题改为「AI_OLD_RESULT」',
      mutationId: 'agent-late', targetPageId: editor.state.page,
      operations: [{ method: 'text.replaceRange', params: { nodeId: titleId, start: 0, end: 'QA_ORIGINAL'.length, text: 'AI_OLD_RESULT', expectedText: 'QA_ORIGINAL' } }],
      items: [{ type: 'AgentMessage', id: 'late', text: '标题改为「AI_OLD_RESULT」', phase: 'Final' }],
    }))
  })
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={() => {}} />) })
  await typeInto('textarea', '细节调整：把标题改成 AI_OLD_RESULT')
  await clickButton('发送')
  expect(editor.state.doc.nodes[frameId].name).toBe('改过的画板')
  await act(async () => { release(undefined) })
  expect(titleText(editor)).toBe('QA_ORIGINAL')
  expect(document.querySelector('[role=alert]')!.textContent).toContain('没有写入')
  expect(document.body.textContent).not.toContain('标题改为「AI_OLD_RESULT」')
  editor.undo()
  expect(editor.state.doc.nodes[frameId].name).toBe('画板')
  expect(titleText(editor)).toBe('QA_ORIGINAL')
})

test('新对话 drops an in-flight result from the previous conversation', async () => {
  const { editor, titleId } = titledEditor()
  const cancelled: string[] = []
  let release: (value: unknown) => void = () => {}
  const pending = new Promise(resolve => { release = resolve })
  let sessionId = ''
  const desktop = host(body => {
    sessionId = String(body.session_id)
    return pending.then(() => ({
      sessionId, skills: ['detail-adjust'], assistant: 'api', summary: '标题改为「AI_OLD_RESULT」',
      mutationId: 'agent-old-conversation', targetPageId: editor.state.page,
      operations: [{ method: 'text.replaceRange', params: { nodeId: titleId, start: 0, end: 'QA_ORIGINAL'.length, text: 'AI_OLD_RESULT', expectedText: 'QA_ORIGINAL' } }],
      items: [
        { type: 'UserMessage', id: 'old-user', text: '细节调整：把标题改成 AI_OLD_RESULT' },
        { type: 'AgentMessage', id: 'old-agent', text: '标题改为「AI_OLD_RESULT」', phase: 'Final' },
      ],
    }))
  }, id => cancelled.push(id))
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={() => {}} />) })
  await typeInto('textarea', '细节调整：把标题改成 AI_OLD_RESULT')
  await clickButton('发送')
  await clickButton('新对话')
  expect(document.querySelectorAll('.design-agent-row')).toHaveLength(0)
  expect(cancelled).toEqual([sessionId])
  await act(async () => { release(undefined) })
  expect(titleText(editor)).toBe('QA_ORIGINAL')
  expect(document.querySelectorAll('.design-agent-row')).toHaveLength(0)
  expect(document.body.textContent).not.toContain('AI_OLD_RESULT')
  expect(editor.canUndo).toBe(false)
})

test('closing the assistant does not give an older result a new conversation', async () => {
  const { editor, titleId } = titledEditor()
  let release: (value: unknown) => void = () => {}
  const pending = new Promise(resolve => { release = resolve })
  const desktop = host(body => pending.then(() => ({
    sessionId: body.session_id, skills: ['detail-adjust'], assistant: 'api', summary: '标题改为「QA_NEW_TITLE」',
    mutationId: 'agent-while-hidden', targetPageId: editor.state.page,
    operations: [{ method: 'text.replaceRange', params: { nodeId: titleId, start: 0, end: 'QA_ORIGINAL'.length, text: 'QA_NEW_TITLE', expectedText: 'QA_ORIGINAL' } }],
    items: [{ type: 'AgentMessage', id: 'hidden', text: '标题改为「QA_NEW_TITLE」', phase: 'Final' }],
  })))
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentDock editor={editor} desktop={desktop} />) })
  await act(async () => { openAgentDock() })
  await typeInto('textarea', '细节调整：把标题改成 QA_NEW_TITLE')
  await clickButton('发送')
  await clickButton('切换')
  expect(document.getElementById('design-agent-dock')!.hidden).toBe(true)
  await act(async () => { release(undefined) })
  expect(titleText(editor)).toBe('QA_NEW_TITLE')
  await act(async () => { openAgentDock() })
  expect(document.body.textContent).toContain('标题改为「QA_NEW_TITLE」')
  editor.undo()
  expect(titleText(editor)).toBe('QA_ORIGINAL')
})

test('a provider 503 is shown and does not generate a page until the rule template is chosen', async () => {
  const editor = new Editor(blank('失败'))
  editors.push(editor)
  const calls: TurnBody[] = []
  const pages = () => editor.state.doc.pages.length
  const before = pages()
  const desktop = host(body => {
    calls.push(body)
    if (body.use_local_rules === true) return quietTurn(body, 'local-rules')
    return {
      sessionId: body.session_id, skills: ['one-click-generate'], assistant: 'api', summary: '已生成页面 NETWORK_SHOULD_FAIL',
      mutationId: 'agent-503', targetPageId: editor.state.page,
      failure: { code: 'unavailable', status: 503, message: '模型服务暂时不可用（HTTP 503）。没有改动画布。可以重试，或改用本机规则模板。' },
      operations: [{ method: 'page.create', params: { id: 'should-not-apply', name: 'NETWORK_SHOULD_FAIL' } }],
      items: [{ type: 'AgentMessage', id: 'fail', text: '模型服务暂时不可用（HTTP 503）。没有改动画布。可以重试，或改用本机规则模板。', phase: 'Final' }],
    }
  })
  const hostElement = document.createElement('div')
  document.body.append(hostElement)
  root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={() => {}} />) })
  await typeInto('textarea', '一键出图：标题 NETWORK_SHOULD_FAIL')
  await clickButton('发送')
  expect(pages()).toBe(before)
  const alert = document.querySelector('[role=alert]')!
  expect(alert.textContent).toContain('503')
  expect(alert.textContent).toContain('没有改动画布')
  expect(document.body.textContent).toContain('任务状态：模型服务失败，画布没有修改。')
  expect(document.body.textContent).not.toContain('api-fallback-local')
  expect(document.body.textContent).not.toContain('已生成页面')
  await clickButton('使用本机规则模板')
  expect(calls.at(-1)!.use_local_rules).toBe(true)
  expect(pages()).toBe(before)
  expect(document.body.textContent).toContain('本机规则模板')
  expect(document.body.textContent).toContain('这不是已配置模型的结果')
})

test('deleting an explicitly targeted page does not silently retarget a request in the same document', async () => {
  const doc = blank('Target boundary'), page = { id: uid(), name: 'Explicit target', children: [] as string[], background: '#ffffff' }
  doc.pages.push(page)
  const editor = new Editor(doc); editors.push(editor)
  const calls: TurnBody[] = []
  const hostElement = document.createElement('div'); document.body.append(hostElement); root = createRoot(hostElement)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={host(body => { calls.push(body); return quietTurn(body) })} onClose={() => {}} initial={{pageId:page.id,prompt:'修改标题',send:false}} />) })
  await act(async () => { editor.change('Delete target', draft => { draft.pages = draft.pages.filter(item => item.id !== page.id) }) })
  await clickButton('发送')
  expect(calls).toHaveLength(0)
  expect(document.querySelector('[role=alert]')?.textContent).toContain('指定的页面不在当前文档中')
})
