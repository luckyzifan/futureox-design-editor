import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentSettings } from './AgentSettings'

const secret = 'synthetic-ui-secret'
const ccSecret = 'synthetic-cc-secret'
const documentName = 'qa-document-must-stay'
const sessionId = 'qa-session-must-stay'
const documentSnapshot = { name: documentName, revision: 7, sessionId, nodes: ['title', 'subtitle'] }

type Provider = { id: string; name: string; kind: string; model: string; base_url: string; active: boolean; has_secret: boolean; secret?: string }
type Call = { method: string; body: unknown }

let root: Root
let mount: HTMLDivElement
let providers: Provider[]
let calls: Call[]
let holdActivate: Promise<void> | null
let failRemove: string

function copyProviders() {
  return providers.map(item => ({ ...item }))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  providers = [
    { id: 'local', name: '本机', kind: 'local', model: 'grok-local', base_url: '', active: false, has_secret: false },
    { id: 'grok', name: 'Grok', kind: 'api', model: 'grok-4', base_url: 'http://127.0.0.1:9/v1', active: false, has_secret: true, secret },
    { id: 'qa-a', name: 'QA A', kind: 'api', model: 'model-a', base_url: 'http://127.0.0.1:9/v1', active: false, has_secret: true, secret },
    { id: 'qa-b', name: 'QA B', kind: 'token_plan', model: 'model-b', base_url: 'http://127.0.0.1:9/v1', active: true, has_secret: true, secret },
    { id: 'ccswitch', name: 'CC Switch', kind: 'ccswitch', model: 'gpt', base_url: 'http://127.0.0.1:15721/v1', active: false, has_secret: false },
  ]
  calls = []
  holdActivate = null
  failRemove = ''
  const designAgent = {
    async status() {
      calls.push({ method: 'status', body: null })
      return {
        status: 'ok' as const,
        providers: copyProviders(),
        ccswitch: {
          present: true,
          providers: [{ id: 'codex-plan', name: 'Codex plan', app_type: 'codex', current: false, kind: 'codex', model: 'plan', has_secret: true, secret: ccSecret }],
        },
      }
    },
    async activate(body: { id: string; profile_id?: string }) {
      calls.push({ method: 'activate', body })
      if (holdActivate) await holdActivate
      providers.forEach(item => { item.active = item.id === body.id })
      return { status: 'ok' as const }
    },
    async remove(body: { id: string }) {
      calls.push({ method: 'remove', body })
      if (failRemove) return { status: 'error' as const, code: 'AGENT_STORE', message: failRemove }
      const index = providers.findIndex(item => item.id === body.id)
      if (index < 0) return { status: 'error' as const, code: 'AGENT', message: `unknown provider ${body.id}` }
      const [removed] = providers.splice(index, 1)
      if (removed.active) {
        const local = providers.find(item => item.id === 'local')
        if (local) local.active = true
      }
      return { status: 'ok' as const }
    },
    async upsert(body: unknown) { calls.push({ method: 'upsert', body }); return { status: 'ok' as const } },
    async turn(body: unknown) { calls.push({ method: 'turn', body }); return { status: 'ok' as const, turn: {} } },
    async cancel(body: unknown) { calls.push({ method: 'cancel', body }); return { status: 'ok' as const } },
  }
  ;(window as unknown as { coreDesktop?: unknown }).coreDesktop = { version: 1, renderPolicy: { cpuOnly: true }, designAgent }
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})

afterEach(async () => {
  await act(async () => root.unmount())
  mount.remove()
  vi.unstubAllGlobals()
})

const savedList = () => document.querySelector<HTMLElement>('[aria-label="已保存的连接"]')!
const row = (name: string) => [...savedList().querySelectorAll('li')].find(item => item.textContent?.includes(name))!
const button = (name: string, label: string) => row(name).querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)
const alert = () => document.querySelector<HTMLElement>('[role="alert"]')

test('saved API and token-plan rows can activate and delete without showing secrets or touching the document', async () => {
  const before = JSON.stringify(documentSnapshot)
  await act(async () => root.render(<AgentSettings />))
  expect(savedList().querySelectorAll('input, select, textarea')).toHaveLength(0)
  expect(button('QA A', '用这条连接')?.textContent).toBe('用这条连接')
  expect(button('QA A', '删除连接')?.textContent).toBe('删除')
  expect(button('QA B', '使用中')?.disabled).toBe(true)
  expect(button('QA B', '删除连接')?.textContent).toBe('删除')
  expect(button('本机', '用这条连接')).toBeTruthy()
  expect(button('本机', '删除连接')).toBeNull()
  expect(button('Grok', '删除连接')).toBeNull()
  expect(button('CC Switch', '删除连接')).toBeNull()
  expect(savedList().querySelectorAll('button').length).toBe(7)
  expect(document.body.textContent).not.toContain(secret)
  expect(document.body.textContent).not.toContain(ccSecret)
  expect(document.body.textContent).not.toContain(documentName)

  expect(button('QA A', '用这条连接')?.classList.contains('agent-connection-action')).toBe(true)
  expect(button('QA A', '删除连接')?.classList.contains('danger')).toBe(true)
  await act(async () => button('QA A', '用这条连接')!.click())
  expect(calls.filter(item => item.method === 'activate').at(-1)).toEqual({ method: 'activate', body: { id: 'qa-a' } })
  expect([...document.querySelectorAll('[role="status"]')].some(item => item.textContent?.includes('已改用「QA A」'))).toBe(true)
  expect(button('QA A', '使用中')?.disabled).toBe(true)
  expect(button('QA B', '用这条连接')?.disabled).toBe(false)
  expect((document.querySelector('input[aria-label="密钥"]') as HTMLInputElement).value).toBe('')

  await act(async () => row('本机').querySelector('.agent-saved-summary')!.click())
  expect(calls.filter(item => item.method === 'activate').at(-1)).toEqual({ method: 'activate', body: { id: 'local' } })

  await act(async () => button('QA A', '删除连接')!.click())
  expect(calls.filter(item => item.method === 'remove')).toEqual([{ method: 'remove', body: { id: 'qa-a' } }])
  expect(calls.some(item => item.method === 'turn' || item.method === 'upsert' || item.method === 'cancel')).toBe(false)
  expect(row('QA A')).toBeUndefined()
  expect([...document.querySelectorAll('[role="status"]')].some(item => item.textContent?.includes('已删除「QA A」'))).toBe(true)
  expect(document.body.textContent).not.toContain(secret)
  expect(JSON.stringify(calls)).not.toContain(secret)
  expect(JSON.stringify(calls)).not.toContain(documentName)
  expect(JSON.stringify(calls)).not.toContain(sessionId)
  expect(JSON.stringify(documentSnapshot)).toBe(before)

  const upstream = [...document.querySelector('[aria-label="CC Switch 供应商"]')!.querySelectorAll('button')].find(item => item.textContent === '用这条连接')!
  await act(async () => upstream.click())
  expect(calls.filter(item => item.method === 'activate').at(-1)).toEqual({ method: 'activate', body: { id: 'ccswitch', profile_id: 'codex:codex-plan' } })
  expect(document.body.textContent).not.toContain(ccSecret)
})

test('delete and activate failures stay visible and leave the saved row in place', async () => {
  const before = JSON.stringify(documentSnapshot)
  failRemove = '连接没有删除：本机配置写入失败（EACCES）。原连接仍在。'
  await act(async () => root.render(<AgentSettings />))
  await act(async () => button('QA A', '删除连接')!.click())
  expect(alert()?.textContent).toBe(failRemove)
  expect(row('QA A')).toBeTruthy()
  expect(button('QA B', '使用中')?.disabled).toBe(true)
  expect(JSON.stringify(documentSnapshot)).toBe(before)
  expect(document.body.textContent).not.toContain(secret)

  let release: () => void = () => {}
  holdActivate = new Promise(resolve => { release = resolve })
  const use = button('QA A', '用这条连接')!
  await act(async () => { use.click() })
  expect(use.disabled).toBe(true)
  expect(button('QA A', '删除连接')?.disabled).toBe(true)
  expect(button('QA B', '使用中')?.disabled).toBe(true)
  await act(async () => { release() })
  expect(button('QA A', '使用中')?.disabled).toBe(true)
  expect(button('QA A', '删除连接')?.disabled).toBe(false)
  expect([...document.querySelectorAll('[role="status"]')].some(item => item.textContent?.includes('已改用「QA A」'))).toBe(true)
})

test('saved connection controls use the hover, disabled, and danger button rules', () => {
  const cssPath = [
    join(process.cwd(), 'src/design-ai/design-agent.css'),
    join(process.cwd(), 'frontend/design-client/src/design-ai/design-agent.css'),
  ].find(candidate => existsSync(candidate))
  if (!cssPath) throw new Error('design-agent.css was not found from the test working directory')
  const css = readFileSync(cssPath, 'utf8')
  expect(css).toContain('.agent-connection-action:not(:disabled):hover')
  expect(css).toContain('.agent-connection-action:disabled')
  expect(css).toContain('.agent-connection-action.danger:not(:disabled):hover')
  expect(css).toContain('cursor: not-allowed')
})
