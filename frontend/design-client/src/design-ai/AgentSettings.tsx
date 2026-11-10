import { useEffect, useRef, useState } from 'react'
import { desktopBridge, type DesktopResult } from '../desktop'
import './design-agent.css'

function refused(result: Exclude<DesktopResult, { status: 'ok' }>) {
  return result.status === 'cancelled' ? '已取消' : result.message
}

type ProviderView = { id: string; name: string; kind: string; model: string; base_url: string; active: boolean; has_secret: boolean }
type CcSwitch = { present?: boolean; detail?: string; providers?: Array<{ id: string; name: string; app_type: string; current: boolean; kind?: string; model?: string; has_secret?: boolean }> }

const builtinIds = new Set(['local', 'grok', 'api', 'token-plan', 'ccswitch'])

function canDelete(provider: ProviderView) {
  return !builtinIds.has(provider.id)
}

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
  const [tone, setTone] = useState<'status' | 'error'>('status')
  const [pending, setPending] = useState('')
  const pendingRef = useRef('')

  const refresh = async () => {
    if (!desktop?.designAgent) {
      setTone('error')
      setMessage('桌面版会连接本机 Rust 助手。网页预览需要先启动 design-agent。')
      return null
    }
    const status = await desktop.designAgent.status()
    if (status.status !== 'ok') { setTone('error'); setMessage(refused(status)); return null }
    const next = status.providers || []
    setProviders(next)
    setCcswitch(status.ccswitch || null)
    return next
  }
  useEffect(() => { void refresh() }, [])

  const useSwitch = async (provider: { id: string; app_type: string; name: string }) => {
    if (!desktop?.designAgent) { setTone('error'); setMessage('请在桌面版里选择 CC Switch 供应商。'); return }
    const result = await desktop.designAgent.activate({ id: 'ccswitch', profile_id: `${provider.app_type}:${provider.id}` })
    if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); return }
    if (!await refresh()) return
    setTone('status')
    setMessage(`已改用 CC Switch 的「${provider.name}」。密钥仍留在 CC Switch 数据库里。`)
  }

  const save = async () => {
    if (!desktop?.designAgent) { setTone('error'); setMessage('请在桌面版里保存 API、Token plan 或 CC Switch。'); return }
    const id = `${kind}-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'custom'}`
    const result = await desktop.designAgent.upsert({
      id, name: name.trim(), kind, base_url: baseUrl.trim(), model: model.trim(), secret, wire: 'openai_chat',
    })
    if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); return }
    setSecret('')
    const activated = await desktop.designAgent.activate({ id })
    if (activated.status !== 'ok') { setTone('error'); setMessage(refused(activated)); await refresh(); return }
    if (!await refresh()) return
    setTone('status')
    setMessage('已保存到本机助手，密钥不会出现在列表里。')
  }

  const activateSaved = async (provider: ProviderView) => {
    if (!desktop?.designAgent || pendingRef.current || provider.active) return
    pendingRef.current = provider.id
    setPending(provider.id)
    try {
      const result = await desktop.designAgent.activate({ id: provider.id })
      if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); await refresh(); return }
      if (!await refresh()) return
      setTone('status')
      setMessage(`已改用「${provider.name}」。下一轮设计对话会打到这条连接。`)
    } catch (error) {
      setTone('error')
      setMessage(error instanceof Error ? error.message : '切换连接失败')
    } finally { pendingRef.current = ''; setPending('') }
  }

  const removeSaved = async (provider: ProviderView) => {
    if (!desktop?.designAgent || pendingRef.current || !canDelete(provider)) return
    pendingRef.current = provider.id
    setPending(provider.id)
    try {
      const result = await desktop.designAgent.remove({ id: provider.id })
      if (result.status !== 'ok') { setTone('error'); setMessage(refused(result)); await refresh(); return }
      const next = await refresh()
      if (!next) return
      const current = next.find(item => item.active)
      setTone('status')
      setMessage(provider.active
        ? `已删除「${provider.name}」。当前使用「${current?.name || '本机助手'}」。`
        : `已删除「${provider.name}」。`)
    } catch (error) {
      setTone('error')
      setMessage(error instanceof Error ? error.message : '删除连接失败')
    } finally { pendingRef.current = ''; setPending('') }
  }

  return <div className="agent-settings">
    <h3>模型连接</h3>
    <p className="settings-help">可以在本机 Grok、已保存的 API、Token plan，以及 CC Switch 里的一条上游之间切换。选中哪一条，下一轮设计对话就打到哪一条。服务失败会保留画布并显示原因，需要时可选择本机规则模板。</p>
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
    {!!providers.length && <ul className="agent-saved-list" aria-label="已保存的连接">{providers.map(provider => <li key={provider.id} className={provider.active ? 'is-active' : undefined} onClick={() => { if (!provider.active && !pending) void activateSaved(provider) }}>
      <span className="agent-saved-summary">{provider.active ? '使用中 · ' : ''}{provider.name} · {provider.kind} · {provider.model}{provider.has_secret ? ' · 已保存密钥' : ''}</span>
      <span className="agent-saved-actions">
        <button type="button" className="agent-connection-action" disabled={provider.active || pending !== ''} aria-label={provider.active ? `使用中：${provider.name}` : `用这条连接：${provider.name}`} onClick={event => { event.stopPropagation(); void activateSaved(provider) }}>{provider.active ? '使用中' : '用这条连接'}</button>
        {canDelete(provider) && <button type="button" className="agent-connection-action danger" disabled={pending !== ''} aria-label={`删除连接：${provider.name}`} onClick={event => { event.stopPropagation(); void removeSaved(provider) }}>删除</button>}
      </span>
    </li>)}</ul>}
    {ccswitch && <div>
      <p role="status">CC Switch 数据库{ccswitch.present ? '已找到' : '未找到'}。{ccswitch.detail || ''}</p>
      {!!ccswitch.providers?.length && <ul aria-label="CC Switch 供应商">{ccswitch.providers.map(provider => <li key={`${provider.app_type}:${provider.id}`} className={provider.current ? 'is-active' : undefined}>{provider.current ? '当前 · ' : ''}{provider.name} · {provider.kind || provider.app_type} · {provider.model || '未写模型'}{provider.has_secret ? ' · 已有密钥' : ' · 缺少可执行地址或密钥'} <button type="button" className="agent-connection-action" onClick={() => void useSwitch(provider)}>用这条连接</button></li>)}</ul>}
    </div>}
    {message && <p role={tone === 'error' ? 'alert' : 'status'}>{message}</p>}
  </div>
}
