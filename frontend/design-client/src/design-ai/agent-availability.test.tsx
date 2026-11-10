// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import type { DesktopBridge } from '../desktop'
import { AgentSettings } from './AgentSettings'
import DesignAgentPanel from './DesignAgentPanel'

let root: Root | undefined
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
  Reflect.deleteProperty(window, 'coreDesktop')
})

function setInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent === name)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${name}`)
  return found
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

test('local mode is visible and one-click generation stays enabled', async () => {
  const editor = new Editor(blank('页面'))
  let turns = 0
  const desktop = {
    version: 1,
    renderPolicy: { cpuOnly: true },
    designAgent: {
      async status() {
        return {
          status: 'ok', mode: 'local', label: '本机模式',
          providers: [{ id: 'local', name: '本机模式', kind: 'local', model: '本机规则', base_url: '', active: true, has_secret: false }],
        }
      },
      async turn() {
        turns += 1
        return {
          status: 'ok',
          turn: {
            sessionId: 's', skills: ['one-click-generate'],
            items: [{ type: 'AgentMessage', id: 'm', text: '已按本机模式生成页面。' }],
            operations: [], mutationId: 'mut', assistant: '本机模式', targetPageId: editor.state.page, summary: '已按本机模式生成页面。',
          },
        }
      },
      async upsert() { return { status: 'ok' } },
      async activate() { return { status: 'ok' } },
      async remove() { return { status: 'ok' } },
      async cancel() { return { status: 'ok' } },
    },
  } as unknown as DesktopBridge
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={() => {}} />) })
  await flush()
  expect(document.querySelector('[data-agent-mode="local"]')?.textContent).toContain('本机模式：不需要外部模型密钥')
  const generate = button('一键出图')
  const adjust = button('细节调整')
  expect(generate.disabled).toBe(false)
  expect(adjust.disabled).toBe(false)
  expect(generate.compareDocumentPosition(adjust) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await act(async () => { generate.click() })
  await flush()
  expect(turns).toBe(1)
  expect(document.body.textContent).toContain('执行者：本机规则模板')
  expect(document.body.textContent).toContain('已按本机模式生成页面。')
  expect(button('一键出图').disabled).toBe(false)
  const css = readFileSync(join(process.cwd(), 'src/design-ai/design-agent.css'), 'utf8')
  expect(css).toContain('.design-agent-target, .design-agent-mode { margin: 8px 12px 0; }')
  expect(css).toContain('.design-ai-actions { display: flex; gap: 8px; align-items: center;')
  expect(css).toContain('.design-agent-panel .primary:hover:not(:disabled)')
  expect(css).toContain('cursor: not-allowed')
  editor.dispose()
})

test('a missing agent is a visible bounded error and the labeled action can be retried', async () => {
  const editor = new Editor(blank('页面'))
  const message = '未找到设计助手程序（/missing/futureox-design-agent）。请重新构建桌面版。'
  let turns = 0
  const desktop = {
    version: 1,
    renderPolicy: { cpuOnly: true },
    designAgent: {
      async status() { return { status: 'error', code: 'AGENT_BIN', message } },
      async turn() { turns += 1; return { status: 'error', code: 'AGENT_BIN', message } },
      async upsert() { return { status: 'ok' } },
      async activate() { return { status: 'ok' } },
      async remove() { return { status: 'ok' } },
      async cancel() { return { status: 'ok' } },
    },
  } as unknown as DesktopBridge
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={() => {}} />) })
  await flush()
  const banner = document.querySelector('[data-agent-mode="error"]')
  expect(banner?.getAttribute('role')).toBe('alert')
  expect(banner?.textContent).toBe(message)
  const generate = button('一键出图')
  expect(generate.disabled).toBe(false)
  await act(async () => { generate.click() })
  await flush()
  expect(turns).toBe(1)
  expect(document.querySelector('.design-agent-composer [role="alert"]')?.textContent).toBe(message)
  editor.dispose()
})

test('settings show local mode, keep the saved connection usable, and can return to local mode', async () => {
  let mode: 'local' | 'configured' = 'local'
  const calls: Array<Record<string, unknown>> = []
  const bridge = {
    version: 1,
    renderPolicy: { cpuOnly: true },
    designAgent: {
      async status() {
        if (mode === 'local') {
          return {
            status: 'ok', mode: 'local', label: '本机模式',
            providers: [{ id: 'local', name: '本机模式', kind: 'local', model: '本机规则', base_url: '', active: true, has_secret: false }],
            ccswitch: { present: false, providers: [] },
          }
        }
        return {
          status: 'ok', mode: 'configured', label: '我的 API',
          providers: [
            { id: 'local', name: '本机模式', kind: 'local', model: '本机规则', base_url: '', active: false, has_secret: false },
            { id: 'api-my-api', name: '我的 API', kind: 'api', model: 'shop', base_url: 'http://127.0.0.1:9/v1', active: true, has_secret: true },
          ],
          ccswitch: { present: false, providers: [] },
        }
      },
      async upsert(body: Record<string, unknown>) { calls.push(body); mode = 'configured'; return { status: 'ok' } },
      async activate(body: Record<string, unknown>) {
        calls.push(body)
        mode = body.id === 'local' ? 'local' : 'configured'
        return { status: 'ok' }
      },
      async turn() { return { status: 'ok', turn: {} } },
      async remove() { return { status: 'ok' } },
      async cancel() { return { status: 'ok' } },
    },
  }
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: bridge })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<AgentSettings />) })
  await flush()
  expect(document.querySelector('[data-agent-mode="local"]')?.textContent).toContain('本机模式：不需要外部模型密钥')
  expect(button('改用本机模式').disabled).toBe(false)
  expect(button('保存并使用').disabled).toBe(false)
  const address = document.querySelector('[aria-label="接口地址"]')
  const model = document.querySelector('[aria-label="模型名"]')
  const secret = document.querySelector('[aria-label="密钥"]')
  if (!(address instanceof HTMLInputElement) || !(model instanceof HTMLInputElement) || !(secret instanceof HTMLInputElement)) throw new Error('missing settings fields')
  await act(async () => {
    setInput(address, 'http://127.0.0.1:9/v1')
    setInput(model, 'shop')
    setInput(secret, 'not-a-real-key')
  })
  await act(async () => { button('保存并使用').click() })
  await flush()
  expect(calls.some(item => item.base_url === 'http://127.0.0.1:9/v1' && item.secret === 'not-a-real-key')).toBe(true)
  expect(document.body.textContent).toContain('已保存到本机助手，密钥不会出现在列表里。')
  expect(document.body.textContent).not.toContain('not-a-real-key')
  expect(button('保存并使用').disabled).toBe(false)
  await act(async () => { button('改用本机模式').click() })
  await flush()
  expect(calls.some(item => item.id === 'local')).toBe(true)
  expect(document.querySelector('[data-agent-mode="local"]')?.textContent).toContain('已改用本机模式')
  expect(button('改用本机模式').disabled).toBe(false)
})

test('an open assistant updates the connection banner when settings change', async () => {
  const editor = new Editor(blank('Connection banner'))
  let configured = false
  const desktop = { designAgent: { async status() { return { status: 'ok', mode: configured ? 'configured' : 'local', label: configured ? 'QA connection' : '本机模式', providers: [{active:true,kind:configured?'api':'local',name:configured?'QA connection':'本机模式'}] } } } } as unknown as DesktopBridge
  const host = document.createElement('div');document.body.append(host);root=createRoot(host)
  await act(async()=>{root!.render(<DesignAgentPanel editor={editor} desktop={desktop} onClose={()=>{}} />)})
  await flush();expect(document.querySelector('.design-agent-panel [data-agent-mode=local]')).not.toBeNull()
  configured=true
  await act(async()=>{window.dispatchEvent(new Event('futureox-agent-connection-changed'))})
  await flush();expect(document.querySelector('.design-agent-panel [data-agent-mode=configured]')?.textContent).toContain('QA connection')
  configured=false
  await act(async()=>{window.dispatchEvent(new Event('futureox-agent-connection-changed'))})
  await flush();expect(document.querySelector('.design-agent-panel [data-agent-mode=local]')).not.toBeNull()
  editor.dispose()
})
