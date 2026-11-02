import { useEffect, useRef, useState } from 'react'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { modalKeyDown } from './modal-keyboard'
import { useInterfacePreferences } from './interface-preference'
import { pluginApiCoverage, pluginBundleFromFiles, samplePluginBundle, sampleUiPluginBundle, openPlugin, PluginApiError, type PluginController } from './plugins'
import './PluginHostDialog.css'

export function PluginHostDialog({ editor, desktop, onClose }: { editor: Editor; desktop?: DesktopBridge | null; onClose: () => void }) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const coverage = pluginApiCoverage()
  const folder = useRef<HTMLInputElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<PluginController | null>(null)
  const queued = useRef<unknown[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [ui, setUi] = useState<PluginController['ui']>(null)
  const [frameUrl, setFrameUrl] = useState('')
  const [draft, setDraft] = useState('{"type":"create-label","text":"Futureox"}')
  const text = en
    ? { title: 'Plugins', close: 'Close plugins', lead: 'Run a Figma-style plugin against the open document. The sample creates a labeled frame. A folder needs manifest.json and code.js.', sample: 'Run sample', uiSample: 'Run UI sample', folder: 'Load plugin folder', coverage: 'API coverage', send: 'Send JSON message', fallback: 'Scripted plugin UI runs in the desktop app. This form sends one JSON message to the plugin.' }
    : { title: '插件', close: '关闭插件', lead: '在当前文档上运行 Figma 风格插件。示例会创建一个带文字的画板。文件夹需要 manifest.json 和 code.js。', sample: '运行示例', uiSample: '运行界面示例', folder: '载入插件文件夹', coverage: 'API 覆盖', send: '发送 JSON 消息', fallback: '带脚本的插件界面在桌面版的隔离页面里运行。这里可以把一条 JSON 消息发给插件。' }

  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); folder.current?.setAttribute('directory', '') }, [])
  useEffect(() => () => { controller.current?.close(); controller.current = null }, [])

  function postToFrame(message: unknown) {
    const target = frame.current?.contentWindow
    if (!target) { queued.current.push(message); return }
    target.postMessage({ pluginMessage: message }, '*')
  }
  useEffect(() => {
    const target = frame.current?.contentWindow
    if (!target || !frameUrl) return
    for (const message of queued.current.splice(0)) target.postMessage({ pluginMessage: message }, '*')
  }, [frameUrl])
  useEffect(() => {
    if (!ui || !desktop?.pluginUi) { setFrameUrl(''); return }
    let cancelled = false
    let published: string | undefined
    void desktop.pluginUi.publish({ html: ui.html }).then(result => {
      if (cancelled) { if (result.status === 'ok') void desktop.pluginUi?.revoke({ id: result.id }); return }
      if (result.status === 'ok') { published = result.id; setFrameUrl(result.url) }
      else if (result.status !== 'cancelled') setError(result.message)
    })
    return () => { cancelled = true; if (published) void desktop.pluginUi?.revoke({ id: published }) }
  }, [ui, desktop])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object' || !('pluginMessage' in data)) return
      try { controller.current?.deliver((data as { pluginMessage: unknown }).pluginMessage) }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function run(load: () => Promise<Parameters<typeof openPlugin>[1]>) {
    setBusy(true); setError(''); setUi(null); setFrameUrl(''); queued.current = []
    controller.current?.close(); controller.current = null
    try {
      const bundle = await load()
      const next = await openPlugin(editor, bundle, { onPostMessage: postToFrame })
      controller.current = next
      setLog([...next.notifications, ...next.logs])
      setUi(next.ui)
      if (next.closed) { next.close(); controller.current = null }
    } catch (failure) {
      setError(failure instanceof PluginApiError ? `${failure.code}: ${failure.message}` : failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  return <div className="modal-backdrop">
    <section className="remote-modal plugin-host-dialog" role="dialog" aria-modal="true" aria-label={text.title} onKeyDown={event => modalKeyDown(event, () => { controller.current?.close(); onClose() })}>
      <h2>{text.title}<button type="button" autoFocus aria-label={text.close} onClick={() => { controller.current?.close(); onClose() }}>{en ? 'Close' : '关闭'}</button></h2>
      <p className="plugin-host-lead">{text.lead}</p>
      <div className="plugin-host-actions">
        <button type="button" className="primary" data-testid="plugin-run-sample" disabled={busy} onClick={() => void run(async () => samplePluginBundle())}>{text.sample}</button>
        <button type="button" data-testid="plugin-run-ui-sample" disabled={busy} onClick={() => void run(async () => sampleUiPluginBundle())}>{text.uiSample}</button>
        <button type="button" disabled={busy} onClick={() => folder.current?.click()}>{text.folder}</button>
        <input ref={folder} hidden type="file" multiple data-testid="plugin-folder" onChange={event => {
          const files = event.target.files
          event.target.value = ''
          if (files?.length) void run(() => pluginBundleFromFiles(files))
        }} />
      </div>
      {error && <p role="alert">{error}</p>}
      {log.length > 0 && <pre className="plugin-host-log" role="status">{log.join('\n')}</pre>}
      {ui && frameUrl && <iframe ref={frame} className="plugin-host-frame" title={text.title} sandbox="allow-scripts" src={frameUrl} style={{ width: ui.width, height: ui.height }} />}
      {ui && !frameUrl && <form className="plugin-host-message" onSubmit={event => {
        event.preventDefault()
        try { controller.current?.deliver(JSON.parse(draft)) }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
      }}>
        <p>{text.fallback}</p>
        <textarea aria-label={text.send} value={draft} onChange={event => setDraft(event.target.value)} />
        <button type="submit" data-testid="plugin-send-json">{text.send}</button>
      </form>}
      <details>
        <summary>{text.coverage} · {coverage.counts.supported} supported · {coverage.counts.partial} partial · {coverage.counts.unsupported} unsupported</summary>
        <ul className="plugin-host-coverage">
          {coverage.entries.map(entry => <li key={entry.api} data-status={entry.status}><code>{entry.api}</code> · {entry.status}. {entry.notes}</li>)}
        </ul>
      </details>
    </section>
  </div>
}
