import { useEffect, useRef, useState } from 'react'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { modalKeyDown } from './modal-keyboard'
import { useInterfacePreferences } from './interface-preference'
import { pluginApiCoverage, pluginBundleFromFiles, pluginBundleFromZip, pluginEditorEvents, pluginUiMessage, pluginUiSrcdoc, samplePluginBundle, sampleUiPluginBundle, openPlugin, PluginApiError, type PluginBundle, type PluginController } from './plugins'
import './PluginHostDialog.css'

export function PluginHostDialog({ editor, desktop, onClose }: { editor: Editor; desktop?: DesktopBridge | null; onClose: () => void }) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const coverage = pluginApiCoverage()
  const folder = useRef<HTMLInputElement>(null)
  const archive = useRef<HTMLInputElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<PluginController | null>(null)
  const pluginId = useRef('')
  const queued = useRef<unknown[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [ui, setUi] = useState<PluginController['ui']>(null)
  const [frameUrl, setFrameUrl] = useState('')
  const [pending, setPending] = useState<PluginBundle | null>(null)
  const [networkNote, setNetworkNote] = useState('')
  const text = en
    ? { title: 'Plugins', close: 'Close plugins', lead: 'Run a Figma plugin on the open document. Load a folder or a .zip / .figma archive with manifest.json and code.js. The sample creates a labeled frame.', sample: 'Run sample', uiSample: 'Run UI sample', folder: 'Load plugin folder', archive: 'Load .zip / .figma', coverage: 'API coverage', commands: 'Choose a command', network: 'Network is limited to the domains in networkAccess. The UI frame still cannot connect, and there is no account or collaboration server.' }
    : { title: '插件', close: '关闭插件', lead: '在当前文档上运行 Figma 插件。可以载入包含 manifest.json 和 code.js 的文件夹，或 .zip / .figma 压缩包。示例会创建一个带文字的画板。', sample: '运行示例', uiSample: '运行界面示例', folder: '载入插件文件夹', archive: '载入 .zip / .figma', coverage: 'API 覆盖', commands: '选择命令', network: '网络仅限 networkAccess 声明的域名。界面帧仍不能联网，也没有账号或协作服务器。' }

  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); folder.current?.setAttribute('directory', '') }, [])
  useEffect(() => () => { controller.current?.close(); controller.current = null }, [])

  function postToFrame(message: unknown) {
    const target = frame.current?.contentWindow
    if (!target) { queued.current.push(message); return }
    target.postMessage(pluginUiMessage(pluginId.current, message), '*')
  }
  function flushQueued() {
    const target = frame.current?.contentWindow
    if (!target) return
    for (const message of queued.current.splice(0)) target.postMessage(pluginUiMessage(pluginId.current, message), '*')
  }
  useEffect(() => {
    if (!ui?.html || !desktop?.pluginUi) { setFrameUrl(''); return }
    let cancelled = false
    let published: string | undefined
    void desktop.pluginUi.publish({ html: ui.html }).then(result => {
      if (cancelled) { if (result.status === 'ok') void desktop.pluginUi?.revoke({ id: result.id }); return }
      if (result.status === 'ok') { published = result.id; setFrameUrl(result.url) }
      else if (result.status !== 'cancelled') setError(result.message)
    })
    return () => { cancelled = true; if (published) void desktop.pluginUi?.revoke({ id: published }) }
  }, [ui?.html, desktop])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object' || !('pluginMessage' in data)) return
      void Promise.resolve(controller.current?.deliver((data as { pluginMessage: unknown }).pluginMessage)).then(() => {
        if (controller.current?.closed) { controller.current.close(); controller.current = null; setUi(null) }
      }).catch(failure => { setError(failure instanceof Error ? failure.message : String(failure)) })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  useEffect(() => {
    let pageId = editor.state.page
    let selection = editor.state.selection.join('\0')
    let revision = editor.state.version
    return editor.subscribe(() => {
      const next = { pageId: editor.state.page, selection: editor.state.selection.join('\0'), revision: editor.state.version }
      const events = pluginEditorEvents({ pageId, selection, revision }, next, !!controller.current?.applying)
      pageId = next.pageId
      selection = next.selection
      revision = next.revision
      for (const event of events) {
        try { controller.current?.emit(event) }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
      }
    })
  }, [editor])

  async function run(load: () => Promise<PluginBundle>, command?: string) {
    setBusy(true); setError(''); setUi(null); setFrameUrl(''); setPending(null); queued.current = []
    controller.current?.close(); controller.current = null
    try {
      const bundle = await load()
      setNetworkNote(bundle.manifest.networkIgnored ? text.network : '')
      if (!command && bundle.manifest.commands.length) { setPending(bundle); return }
      pluginId.current = bundle.manifest.id
      const next = await openPlugin(editor, bundle, { onPostMessage: postToFrame, onUi: setUi, command, storage: undefined })
      controller.current = next.closed ? null : next
      setLog([...next.notifications, ...next.logs])
      setUi(next.closed ? null : next.ui)
      if (next.closed) next.close()
    } catch (failure) {
      setError(failure instanceof PluginApiError ? `${failure.code}: ${failure.message}` : failure instanceof Error ? failure.message : String(failure))
    } finally { setBusy(false) }
  }

  const frameTitle = ui?.title || text.title
  return <div className="modal-backdrop">
    <section className="remote-modal plugin-host-dialog" role="dialog" aria-modal="true" aria-label={text.title} onKeyDown={event => modalKeyDown(event, () => { controller.current?.close(); onClose() })}>
      <h2>{text.title}<button type="button" autoFocus aria-label={text.close} onClick={() => { controller.current?.close(); onClose() }}>{en ? 'Close' : '关闭'}</button></h2>
      <p className="plugin-host-lead">{text.lead}</p>
      <div className="plugin-host-actions">
        <button type="button" className="primary" data-testid="plugin-run-sample" disabled={busy} onClick={() => void run(async () => samplePluginBundle())}>{text.sample}</button>
        <button type="button" data-testid="plugin-run-ui-sample" disabled={busy} onClick={() => void run(async () => sampleUiPluginBundle())}>{text.uiSample}</button>
        <button type="button" disabled={busy} onClick={() => folder.current?.click()}>{text.folder}</button>
        <button type="button" data-testid="plugin-archive-button" disabled={busy} onClick={() => archive.current?.click()}>{text.archive}</button>
        <input ref={folder} hidden type="file" multiple data-testid="plugin-folder" onChange={event => {
          const files = event.target.files
          event.target.value = ''
          if (files?.length) void run(() => pluginBundleFromFiles(files))
        }} />
        <input ref={archive} hidden type="file" accept=".zip,.figma,application/zip" data-testid="plugin-archive" onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void run(async () => pluginBundleFromZip(new Uint8Array(await file.arrayBuffer())))
        }} />
      </div>
      {pending && <div className="plugin-host-commands">
        <p>{text.commands}</p>
        {pending.manifest.commands.map(item => <button key={item.command} type="button" disabled={busy} onClick={() => void run(async () => pending, item.command)}>{item.name}</button>)}
      </div>}
      {networkNote && <p role="status">{networkNote}</p>}
      {error && <p role="alert">{error}</p>}
      {log.length > 0 && <pre className="plugin-host-log" role="status">{log.join('\n')}</pre>}
      {ui?.visible && frameUrl && <iframe ref={frame} className="plugin-host-frame" title={frameTitle} sandbox="allow-scripts" src={frameUrl} style={{ width: ui.width, height: ui.height }} onLoad={flushQueued} />}
      {ui?.visible && !frameUrl && !desktop?.pluginUi && <iframe ref={frame} className="plugin-host-frame" title={frameTitle} sandbox="allow-scripts" srcDoc={pluginUiSrcdoc(ui.html)} style={{ width: ui.width, height: ui.height }} onLoad={flushQueued} />}
      <details>
        <summary>{text.coverage} · {coverage.counts.supported} supported · {coverage.counts.partial} partial · {coverage.counts.unsupported} unsupported</summary>
        <ul className="plugin-host-coverage">
          {coverage.entries.map(entry => <li key={entry.api} data-status={entry.status}><code>{entry.api}</code> · {entry.status}. {entry.notes}</li>)}
        </ul>
      </details>
    </section>
  </div>
}
