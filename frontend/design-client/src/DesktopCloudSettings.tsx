import { useEffect, useId, useState } from 'react'
import type { DesktopCloudStatus } from './desktop'

export function DesktopCloudSettings({ status, locale, configure }: {
  status?: DesktopCloudStatus
  locale: 'zh-CN' | 'en'
  configure(request: { enabled: boolean; baseUrl?: string; token?: string }): Promise<void>
}) {
  const english = locale === 'en', id = useId()
  const [enabled, setEnabled] = useState(status?.enabled ?? false)
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    setEnabled(status?.enabled ?? false)
    setBaseUrl(status?.baseUrl ?? '')
    setToken('')
  }, [status])
  async function change(enabled: boolean) {
    setError(''); setBusy(true)
    try { await configure(enabled ? { enabled, baseUrl: baseUrl.trim(), token } : { enabled }); setToken('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); if (!enabled) setEnabled(true) }
    finally { setBusy(false) }
  }
  return <div className="settings-control">
    <h3>{english ? 'Cloud collaboration' : '云端协作'}</h3>
    <label className="settings-toggle">
      <input type="checkbox" checked={enabled} disabled={busy} aria-describedby={id}
        onChange={event => {
          const selected = event.target.checked
          setEnabled(selected)
          if (!selected && status?.enabled) void change(false)
        }} />
      <span>{english ? 'Enable cloud collaboration' : '启用云端协作'}</span>
    </label>
    <p className="settings-help" id={id}>{english
      ? 'Edits are saved to local SQLite first. Shared designs sync when the service is reachable.'
      : '编辑先保存到本机 SQLite。协作服务可达时同步已关联的设计。'}</p>
    {enabled && <form className="settings-cloud-form" onSubmit={event => { event.preventDefault(); void change(true) }}>
      <label>{english ? 'Cloud service address' : '云端服务地址'}
        <input type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://futureox.com/desgin" disabled={busy} />
      </label>
      <label>{english ? 'Workspace access token' : '工作区访问令牌'}
        <input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)}
          placeholder={status?.remembersToken && status.baseUrl === baseUrl.trim()
            ? english ? 'Use stored token' : '使用已保存的令牌' : undefined} disabled={busy} />
      </label>
      <button type="submit" className="secondary" disabled={busy}>{english ? 'Connect to cloud' : '连接云端'}</button>
      {status?.handle && <p role="status">{english ? 'Cloud collaboration enabled' : '云端协作已开启'}</p>}
      {status?.enabled && !status.handle && <p role="status">{english ? 'Enter a token to reconnect' : '请填写令牌以重新连接'}</p>}
    </form>}
    {error && <p role="alert">{error}</p>}
  </div>
}
