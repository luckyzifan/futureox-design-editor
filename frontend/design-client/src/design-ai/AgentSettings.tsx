import { useEffect, useState } from 'react'
import { desktopBridge } from '../desktop'

type ProviderView = { id: string; name: string; kind: string; model: string; base_url: string; active: boolean; has_secret: boolean }
type CcSwitch = { present?: boolean; proxy?: string | null; detail?: string; providers?: Array<{ id: string; name: string; app_type: string; current: boolean }> }

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

  const refresh = async () => {
    if (!desktop?.designAgent) { setMessage('桌面版会连接本机 Rust 助手。网页预览需要先启动 design-agent。'); return }
    const status = await desktop.designAgent.status()
    if (status.status !== 'ok') { setMessage(status.message); return }
    setProviders(status.providers || [])
    setCcswitch(status.ccswitch || null)
    setMessage('')
  }
  useEffect(() => { void refresh() }, [])

  const save = async () => {
    if (!desktop?.designAgent) { setMessage('请在桌面版里保存 API、Token plan 或 CC Switch。'); return }
    const id = `${kind}-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'custom'}`
    const result = await desktop.designAgent.upsert({
      id, name: name.trim(), kind, base_url: baseUrl.trim(), model: model.trim(), secret, wire: 'openai_chat',
    })
    if (result.status !== 'ok') { setMessage(result.message); return }
    setSecret('')
    await desktop.designAgent.activate({ id })
    await refresh()
    setMessage('已保存到本机助手，密钥不会出现在列表里。')
  }

  return <div className="agent-settings">
    <h3>模型连接</h3>
    <p className="settings-help">可以同时保存多个 API 或 Token plan。CC Switch 走本机路由（默认 127.0.0.1:15721），用来切换上游。没有密钥时，对话仍用本机 Grok / Cursor 助手规则直接改页面。</p>
    <label>类型<select aria-label="连接类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="api">API</option>
      <option value="token_plan">Token plan</option>
      <option value="ccswitch">CC Switch</option>
    </select></label>
    <label>名称<input aria-label="连接名称" value={name} onChange={event => setName(event.target.value)} /></label>
    <label>地址<input aria-label="接口地址" placeholder={kind === 'ccswitch' ? 'http://127.0.0.1:15721/v1' : 'https://…/v1'} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label>模型<input aria-label="模型名" value={model} onChange={event => setModel(event.target.value)} /></label>
    <label>{kind === 'token_plan' ? 'Plan token' : 'API key'}<input aria-label="密钥" type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    <button type="button" onClick={() => void save()}>保存并使用</button>
    {!!providers.length && <ul aria-label="已保存的连接">{providers.map(provider => <li key={provider.id}>{provider.active ? '使用中 · ' : ''}{provider.name} · {provider.kind} · {provider.model}{provider.has_secret ? ' · 已保存密钥' : ''}</li>)}</ul>}
    {ccswitch && <p role="status">CC Switch 数据库{ccswitch.present ? '已找到' : '未找到'}。{ccswitch.proxy ? `路由 ${ccswitch.proxy}。` : ''}{ccswitch.detail || ''}</p>}
    {message && <p role="status">{message}</p>}
  </div>
}
