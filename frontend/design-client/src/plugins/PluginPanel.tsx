import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../engine'
import { desktopBridge, type DesktopBridge } from '../desktop'
import { useInterfacePreferences } from '../interface-preference'
import { modalKeyDown } from '../modal-keyboard'
import { acceptedDeclaredPlugins, declaredPluginFiles, type DeclaredPlugin } from './catalog'
import { pluginApiCoverage, pluginCoverageCounts } from './coverage'
import { commitPluginResult, pluginEditLabel, snapshotFromEditor } from './commit'
import { PluginClient } from './launch'
import { parsePluginManifest, type PluginManifest } from './manifest'
import { samplePlugin } from './sample-plugin'
import type { PluginWorkerReply } from './protocol'
import './plugin-panel.css'

const copy = {
  'zh-CN': {
    title: 'Figma 插件',
    close: '关闭',
    sample: '运行示例插件',
    load: '加载插件文件夹…',
    stop: '停止插件',
    intro: '示例会在当前页面创建三个带标签的矩形。桌面版在启动时启用本机 plugins 文件夹里已声明的插件，也可以手动加载含 manifest.json 的文件夹。启动扫描不会改画布。',
    desktopUi: '插件界面在单独的沙箱窗口中打开。',
    webUi: '插件主程序已运行。插件界面窗口只在桌面版提供。',
    matrix: 'API 覆盖',
    path: '示例文件夹：frontend/design-client/plugins/labeled-rectangles',
    enabled: '启动时已启用',
    run: '运行',
    none: '这次启动没有启用本机插件。放入插件文件夹后重新打开桌面应用。',
    missing: '这个本机插件已不再启用。',
  },
  en: {
    title: 'Figma plugins',
    close: 'Close',
    sample: 'Run sample plugin',
    load: 'Load plugin folder…',
    stop: 'Stop plugin',
    intro: 'The sample creates three labeled rectangles on the current page. The desktop app enables declared plugins from its local plugins folder at startup, and can also load a folder that contains manifest.json. The startup scan does not change the canvas.',
    desktopUi: 'The plugin interface opens in its own sandboxed window.',
    webUi: 'The plugin main script ran. The plugin UI window is available in the desktop app.',
    matrix: 'API coverage',
    path: 'Sample folder: frontend/design-client/plugins/labeled-rectangles',
    enabled: 'Enabled at startup',
    run: 'Run',
    none: 'No local plugins were enabled at startup. Add a plugin folder and reopen the desktop app.',
    missing: 'That local plugin is no longer enabled.',
  },
} as const

export function PluginPanel({ editor, desktop = desktopBridge(), launch = null, onClose }: {
  editor: Editor
  desktop?: DesktopBridge
  launch?: { grant: string; token: number } | null
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const text = copy[locale]
  const counts = pluginCoverageCounts()
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [enabled, setEnabled] = useState<DeclaredPlugin[] | null>(null)
  const client = useRef<PluginClient | null>(null)
  const launchSeen = useRef<number | null>(null)
  const runListedRef = useRef<(plugin: DeclaredPlugin) => Promise<void>>(async () => {})
  const generation = useRef(0)
  const expected = useRef({ documentId: '', revision: 0 })
  const uiOpen = useRef(false)
  const unlisten = useRef<(() => void) | null>(null)

  function stop() {
    generation.current += 1
    client.current?.stop()
    client.current = null
    uiOpen.current = false
    unlisten.current?.()
    unlisten.current = null
    void desktop?.plugins?.closeUi()
    setRunning(false)
  }

  useEffect(() => stop, [desktop])

  useEffect(() => {
    const list = desktop?.plugins?.list
    if (!list) return
    let live = true
    void list().then(result => {
      if (!live) return
      if (result.status === 'ok') setEnabled(acceptedDeclaredPlugins(result.plugins))
      else if (result.status === 'error' || result.status === 'conflict') { setEnabled([]); setError(result.message) }
      else setEnabled([])
    }).catch(cause => {
      if (live) { setEnabled([]); setError(cause instanceof Error ? cause.message : String(cause)) }
    })
    return () => { live = false }
  }, [desktop])

  async function apply(reply: PluginWorkerReply, token: number, manifest: PluginManifest) {
    if (token !== generation.current) return
    if (!reply.ok) { setError(reply.message); stop(); return }
    const result = commitPluginResult(editor, pluginEditLabel(manifest.name), expected.current, reply.turn)
    if (token !== generation.current) return
    if (result.status === 'rejected') { setError(result.message ?? ''); stop(); return }
    expected.current = { documentId: editor.state.doc.id, revision: editor.state.version }
    setStatus(result.message || manifest.name)
    if (reply.turn.closed) { setStatus(reply.turn.closeMessage || text.close); stop(); return }
    if (reply.turn.ui?.visible && desktop?.plugins) {
      if (!uiOpen.current) {
        uiOpen.current = true
        const opened = await desktop.plugins.openUi(reply.turn.ui)
        if (opened.status === 'error') setError(opened.message)
        else setStatus(text.desktopUi)
      }
      for (const pluginMessage of reply.turn.outbound) await desktop.plugins.postUi({ pluginMessage })
    } else if (reply.turn.ui?.visible) setStatus(text.webUi)
  }

  async function run(manifest: PluginManifest, mainSource: string, uiHtml: string, notes: string[]) {
    stop()
    const token = generation.current
    setError('')
    setWarnings(notes)
    setRunning(true)
    try {
      const snapshot = snapshotFromEditor(editor)
      expected.current = { documentId: snapshot.documentId, revision: snapshot.revision }
      const next = new PluginClient()
      client.current = next
      if (desktop?.plugins) {
        const offMessage = desktop.plugins.onUiMessage(message => { void next.ui(message.pluginMessage).then(reply => apply(reply, token, manifest)) })
        const offClosed = desktop.plugins.onUiClosed(() => { if (token === generation.current) stop() })
        unlisten.current = () => { offMessage(); offClosed() }
      }
      await apply(await next.start({
        type: 'start', snapshot, mainSource, uiHtml,
        pluginId: manifest.id, pluginName: manifest.name, command: 'run',
      }), token, manifest)
    } catch (cause) {
      if (token === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); stop() }
    }
  }

  async function runSample() {
    const parsed = parsePluginManifest(samplePlugin.manifestText)
    await run(parsed.manifest, samplePlugin.mainSource, samplePlugin.uiHtml, parsed.warnings)
  }

  async function runManifest(grant: string, manifestText: string) {
    const plugins = desktop?.plugins
    if (!plugins) return
    const parsed = parsePluginManifest(manifestText)
    const paths = declaredPluginFiles(parsed.manifest)
    const read = await plugins.read({ grant, paths })
    if (read.status === 'cancelled') return
    if (read.status !== 'ok') { setError(read.message); return }
    await run(parsed.manifest, read.files[parsed.manifest.main] ?? '', parsed.manifest.ui ? read.files[parsed.manifest.ui] ?? '' : '', parsed.warnings)
  }

  async function runListed(plugin: DeclaredPlugin) {
    try { await runManifest(plugin.grant, plugin.manifestText) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); stop() }
  }
  runListedRef.current = runListed

  useEffect(() => {
    if (!launch || enabled === null || launchSeen.current === launch.token) return
    launchSeen.current = launch.token
    const entry = enabled.find(plugin => plugin.grant === launch.grant)
    if (!entry) { setError(text.missing); return }
    void runListedRef.current(entry)
  }, [launch, enabled, text.missing])

  async function loadFolder() {
    const plugins = desktop?.plugins
    if (!plugins) return
    const picked = await plugins.pick()
    if (picked.status === 'cancelled') return
    if (picked.status !== 'ok') { setError(picked.message); return }
    try { await runManifest(picked.grant, picked.manifestText) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); stop() }
  }

  return (
    <div className="plugin-panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="plugin-panel" role="dialog" aria-modal="true" aria-labelledby="plugin-panel-title" tabIndex={-1} onKeyDown={event => modalKeyDown(event, onClose)}>
        <header>
          <h2 id="plugin-panel-title">{text.title}</h2>
          <button type="button" onClick={onClose}>{text.close}</button>
        </header>
        <section>
          <p>{text.intro}</p>
          <p>{text.path}</p>
          {enabled && enabled.length > 0 ? (
            <div>
              <h3>{text.enabled}</h3>
              <ul className="plugin-local-list" aria-label={text.enabled}>
                {enabled.map(plugin => (
                  <li key={plugin.grant}>
                    <span>{plugin.name}</span>
                    <button type="button" disabled={running} onClick={() => void runListed(plugin)}>{text.run}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : enabled ? <p>{text.none}</p> : null}
          {warnings.map(warning => <p key={warning}>{warning}</p>)}
          {status ? <p role="status">{status}</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          <details>
            <summary>{text.matrix}: {counts.supported} supported, {counts.partial} partial, {counts.unsupported} unsupported</summary>
            <table>
              <tbody>
                {pluginApiCoverage.map(entry => <tr key={entry.api}><td><code>{entry.api}</code></td><td>{entry.status}</td><td>{entry.note}</td></tr>)}
              </tbody>
            </table>
          </details>
        </section>
        <footer>
          <button type="button" className="plugin-panel-primary" disabled={running} onClick={() => void runSample()}>{text.sample}</button>
          {desktop?.plugins ? <button type="button" disabled={running} onClick={() => void loadFolder()}>{text.load}</button> : null}
          <button type="button" disabled={!running} onClick={stop}>{text.stop}</button>
        </footer>
      </section>
    </div>
  )
}
