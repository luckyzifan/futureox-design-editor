import { useEffect, useState } from 'react'
import { desktopBridge, type DesktopResult } from '../desktop'
import { agentAvailability } from './agent-availability'
import './design-agent.css'

function refused(result: Exclude<DesktopResult, { status: 'ok' }>) {
  return result.status === 'cancelled' ? '已取消' : result.message
}

type ProviderView = { id: string; name: string; kind: string; model: string; base_url: string; active: boolean; has_secret: boolean }
type CcSwitch = { present?: boolean; detail?: string; providers?: Array<{ id: string; name: string; app_type: string; current: boolean; kind?: string; model?: string; has_secret?: boolean }> }

export function AgentSettings() {
  const desktop = desktopBridge()
  const [kind, setKind] = useState<'api' | 'token_plan' | 'ccswitch'>('api')
  const [name, setName] = useState('我的 API')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [secret, setSecret] = useState('')
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [ccswitch, setCcswitch] = useState<CcSwitch | null>(null)
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'local' | 'configured' | 'error' | 'pending'>('pending')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    if (!desktop?.designAgent) {
      setTone('error')
      setMessage('桌面版会连接本机 Rust 助手。网页预览需要先启动 design-agent。')
      return
    }
    const status = await desktop.designAgent.status()
    const availability = agentAvailability(status)
    setTone(availability.tone)
    if (status.status !== 'ok') { setMessage(availability.text); return }
    setProviders(status.providers || [])
    setCcswitch(status.ccswitch || null)
    setMessage(availability.text)
  }
  useEffect(() => { void refresh() }, [])

  const useSwitch = async (provider: { id: string; app_type: string; name: string }) => {
    if (busy) return
    if (!desktop?.designAgent) { setTone('error'); setMessage('请在桌面版里选择 CC Switch 供应商。'); return }
    setBusy(true)
    try {
      const result = await desktop.designAgent.activate({ id: 'ccswitch', profile_id: `${provider.app_type}:${provider.id}` })
      if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); return }
      await refresh()
      setTone('configured')
      setMessage(`已改用 CC Switch 的「${provider.name}」。密钥仍留在 CC Switch 数据库里。`)
    } finally { setBusy(false) }
  }

  const useLocal = async () => {
    if (busy) return
    if (!desktop?.designAgent) { setTone('error'); setMessage('请在桌面版里改用本机模式。'); return }
    setBusy(true)
    try {
      const result = await desktop.designAgent.activate({ id: 'local' })
      if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); return }
      await refresh()
      setTone('local')
      setMessage('已改用本机模式。不需要外部模型密钥，一键出图由本机规则直接改画布。')
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (busy) return
    if (!desktop?.designAgent) { setTone('error'); setMessage('请在桌面版里保存 API、Token plan 或 CC Switch。'); return }
    setBusy(true)
    try {
      const id = `${kind}-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'custom'}`
      const result = await desktop.designAgent.upsert({
        id, name: name.trim(), kind, base_url: baseUrl.trim(), model: model.trim(), secret, wire: 'openai_chat',
      })
      if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); return }
      setSecret('')
      const activated = await desktop.designAgent.activate({ id })
      if (activated.status !== 'ok') { setTone('error'); setMessage(refused(activated)); return }
      await refresh()
      setTone('configured')
      setMessage('已保存到本机助手，密钥不会出现在列表里。')
    } finally { setBusy(false) }
  }

  return <div className="agent-settings">
    <h3>模型连接</h3>
    <p className="settings-help">没有外部模型密钥时使用本机模式，一键出图由本机规则直接改画布。也可以改用已保存的 API、Token plan，或 CC Switch 里的一条上游。</p>
    <label>类型<select aria-label="连接类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="api">API</option>
      <option value="token_plan">Token plan</option>
      <option value="ccswitch">CC Switch</option>
    </select></label>
    <label>名称<input aria-label="连接名称" value={name} onChange={event => setName(event.target.value)} /></label>
    <label>地址<input aria-label="接口地址" placeholder={kind === 'ccswitch' ? 'http://127.0.0.1:15721/v1' : 'https://…/v1'} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label>模型<input aria-label="模型名" value={model} onChange={event => setModel(event.target.value)} /></label>
    <label>{kind === 'token_plan' ? 'Plan token' : 'API key'}<input aria-label="密钥" type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    <div className="design-ai-actions">
      <button type="button" disabled={busy} onClick={() => void save()}>保存并使用</button>
      <button type="button" disabled={busy} onClick={() => void useLocal()}>改用本机模式</button>
    </div>
    {!!providers.length && <ul aria-label="已保存的连接">{providers.map(provider => <li key={provider.id}>{provider.active ? '使用中 · ' : ''}{provider.name} · {provider.kind} · {provider.model}{provider.has_secret ? ' · 已保存密钥' : ''}</li>)}</ul>}
    {ccswitch && <div>
      <p role="status">CC Switch 数据库{ccswitch.present ? '已找到' : '未找到'}。{ccswitch.detail || ''}</p>
      {!!ccswitch.providers?.length && <ul aria-label="CC Switch 供应商">{ccswitch.providers.map(provider => <li key={`${provider.app_type}:${provider.id}`}>{provider.current ? '当前 · ' : ''}{provider.name} · {provider.kind || provider.app_type} · {provider.model || '未写模型'}{provider.has_secret ? ' · 已有密钥' : ' · 缺少可执行地址或密钥'} <button type="button" disabled={busy} onClick={() => void useSwitch(provider)}>用这条连接</button></li>)}</ul>}
    </div>}
    {message && <p role={tone === 'error' ? 'alert' : 'status'} data-agent-mode={tone}>{message}</p>}
  </div>
}
