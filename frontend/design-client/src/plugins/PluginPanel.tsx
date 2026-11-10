import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../engine'
import { desktopBridge, type DesktopBridge } from '../desktop'
import { useInterfacePreferences } from '../interface-preference'
import { modalKeyDown, useModalOwnership } from '../modal-keyboard'
import { acceptedDeclaredPlugins, type DeclaredPlugin } from './catalog'
import { openPlugin, parsePluginManifest as parseRichManifest, pluginBundleFromZip, pluginEditorEvents, PLUGIN_API_COVERAGE, type PluginBundle, type PluginController } from './rich-host'
import { samplePlugin } from './sample-plugin'
import './plugin-panel.css'

const copy = {
  'zh-CN': {
    title: 'Figma 插件',
    close: '关闭',
    sample: '运行示例插件',
    load: '加载插件文件夹…',
    archive: '加载插件压缩包…',
    stop: '停止插件',
    intro: '示例会在当前页面创建三个带标签的矩形。桌面版在启动时启用本机 plugins 文件夹里已声明的插件，也可以手动加载含 manifest.json 的文件夹，或一个 .zip / .figma 压缩包。启动扫描不会改画布，也不会执行压缩包。',
    desktopUi: '插件界面在单独的沙箱窗口中打开。',
    webUi: '插件主程序已运行。插件界面窗口只在桌面版提供。',
    matrix: 'API 覆盖',
    path: '示例文件夹：frontend/design-client/plugins/labeled-rectangles',
    enabled: '启动时已启用',
    run: '运行',
    commands: '选择要运行的命令',
    none: '这次启动没有启用本机插件。放入插件文件夹后重新打开桌面应用。',
    missing: '这个本机插件已不再启用。',
  },
  en: {
    title: 'Figma plugins',
    close: 'Close',
    sample: 'Run sample plugin',
    load: 'Load plugin folder…',
    archive: 'Load plugin archive…',
    stop: 'Stop plugin',
    intro: 'The sample creates three labeled rectangles on the current page. The desktop app enables declared plugins from its local plugins folder at startup, and can also load a folder that contains manifest.json or a .zip / .figma archive. The startup scan does not change the canvas and does not run an archive.',
    desktopUi: 'The plugin interface opens in its own sandboxed window.',
    webUi: 'The plugin main script ran. The plugin UI window is available in the desktop app.',
    matrix: 'API coverage',
    path: 'Sample folder: frontend/design-client/plugins/labeled-rectangles',
    enabled: 'Enabled at startup',
    run: 'Run',
    commands: 'Choose a command',
    none: 'No local plugins were enabled at startup. Add a plugin folder and reopen the desktop app.',
    missing: 'That local plugin is no longer enabled.',
  },
} as const

export function PluginPanel({ editor, desktop = desktopBridge(), launch = null, onClose, returnFocus = null }: {
  editor: Editor
  desktop?: DesktopBridge
  launch?: { grant: string; token: number } | null
  onClose: () => void
  returnFocus?: HTMLElement | null
}) {
  const { locale } = useInterfacePreferences()
  const text = copy[locale]
  const counts = {
    supported: PLUGIN_API_COVERAGE.filter(entry => entry.status === 'supported').length,
    partial: PLUGIN_API_COVERAGE.filter(entry => entry.status === 'partial').length,
    unsupported: PLUGIN_API_COVERAGE.filter(entry => entry.status === 'unsupported').length,
  }
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [pending, setPending] = useState<PluginBundle | null>(null)
  const [enabled, setEnabled] = useState<DeclaredPlugin[] | null>(null)
  const controller = useRef<PluginController | null>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useModalOwnership(backdrop, closeButton, returnFocus)
  const archive = useRef<HTMLInputElement>(null)
  const launchSeen = useRef<number | null>(null)
  const runListedRef = useRef<(plugin: DeclaredPlugin) => Promise<void>>(async () => {})
  const generation = useRef(0)
  const uiOpen = useRef(false)
  const unlisten = useRef<(() => void) | null>(null)
  const stopRef = useRef<() => void>(() => {})

  function stop() {
    generation.current += 1
    controller.current?.close()
    controller.current = null
    uiOpen.current = false
    unlisten.current?.()
    unlisten.current = null
    void desktop?.plugins?.closeUi()
    setRunning(false)
  }

  useEffect(() => stop, [desktop])
  stopRef.current = stop

  useEffect(() => {
    if (typeof editor.subscribe !== 'function') return
    let watch = {
      pageId: editor.state.page, selection: editor.state.selection.join('\0'), revision: editor.state.version,
      documentId: editor.state.doc.id, session: editor.sessionGeneration,
    }
    return editor.subscribe(() => {
      const next = {
        pageId: editor.state.page, selection: editor.state.selection.join('\0'), revision: editor.state.version,
        documentId: editor.state.doc.id, session: editor.sessionGeneration,
      }
      const previous = watch
      watch = next
      const active = controller.current
      if (!active || active.closed) return
      if (next.documentId !== previous.documentId || next.session !== previous.session) {
        stopRef.current()
        return
      }
      const events = pluginEditorEvents(previous, next, active.applying)
      for (const event of events) {
        try {
          const delivered = active.emit(event)
          if (delivered) void Promise.resolve(delivered).catch(failure => {
            setError(failure instanceof Error ? failure.message : String(failure))
            stopRef.current()
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          stopRef.current()
        }
      }
    })
  }, [editor])

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

  async function run(manifestText: string, mainSource: string, uiHtml: string, notes: string[], command?: string) {
    try {
      const manifest = parseRichManifest(JSON.parse(manifestText))
      await runBundle({ manifest, main: mainSource, ui: uiHtml || null }, notes, command)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      stop()
    }
  }

  async function runBundle(bundle: PluginBundle, notes: string[], command?: string) {
    stop()
    const token = generation.current
    setError('')
    setWarnings(notes)
    // A manifest menu is a choice. Loading the file must not run commands[0].
    if (command === undefined && bundle.manifest.commands.length > 0) {
      setPending(bundle)
      setStatus('')
      setRunning(false)
      return
    }
    setPending(null)
    setRunning(true)
    try {
      const manifest = bundle.manifest
      const next = await openPlugin(editor, bundle, {
        command,
        systemFonts: desktop?.fonts ? {
          list: async () => { const listed = await desktop.fonts!.list(); return listed.status === 'ok' ? listed.fonts : null },
          read: async request => { const read = await desktop.fonts!.read(request); return read.status === 'ok' ? { face: read.font, data: read.data } : null },
        } : undefined,
        onNotify: message => { if (token === generation.current) setStatus(message) },
        onUi: ui => {
          if (token !== generation.current || !ui.visible) return
          if (desktop?.plugins) {
            if (uiOpen.current) return
            uiOpen.current = true
            // The host validates an exact record; visibility is handled here,
            // so only the contracted keys cross the bridge.
            void desktop.plugins.openUi({ html: ui.html, width: ui.width, height: ui.height, title: ui.title }).then(opened => {
              if (token !== generation.current) return
              if (opened.status === 'error') setError(opened.message)
              else setStatus(text.desktopUi)
            })
          } else setStatus(text.webUi)
        },
        onPostMessage: message => { void desktop?.plugins?.postUi({ pluginMessage: message }) },
        onClose: message => {
          // closePlugin runs inside a guest host call; finalize the panel only
          // after that turn returns, so a finished plugin frees its window,
          // subscriptions and load entries without a manual stop (#207).
          setTimeout(() => {
            if (token !== generation.current) return
            stop()
            if (message) setStatus(message)
          }, 0)
        },
      })
      if (token !== generation.current) { next.close(); return }
      controller.current = next
      setStatus(manifest.name)
      if (desktop?.plugins) {
        const offMessage = desktop.plugins.onUiMessage(message => { void next.deliver(message.pluginMessage) })
        const offClosed = desktop.plugins.onUiClosed(() => { if (token === generation.current) stop() })
        unlisten.current = () => { offMessage(); offClosed() }
      }
    } catch (cause) {
      if (token === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); stop() }
    }
  }

  async function runSample() {
    await run(samplePlugin.manifestText, samplePlugin.mainSource, samplePlugin.uiHtml, [], 'run')
  }

  async function runManifest(grant: string, manifestText: string) {
    const plugins = desktop?.plugins
    if (!plugins) return
    const manifest = parseRichManifest(JSON.parse(manifestText))
    const paths = manifest.ui ? [manifest.main, manifest.ui] : [manifest.main]
    const read = await plugins.read({ grant, paths })
    if (read.status === 'cancelled') return
    if (read.status !== 'ok') { setError(read.message); return }
    await run(manifestText, read.files[manifest.main] ?? '', manifest.ui ? read.files[manifest.ui] ?? '' : '', [])
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

  async function loadArchive(file: File) {
    try {
      const bundle = pluginBundleFromZip(new Uint8Array(await file.arrayBuffer()))
      await runBundle(bundle, [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      stop()
    }
  }

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
    <div ref={backdrop} className="plugin-panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="plugin-panel" role="dialog" aria-modal="true" aria-labelledby="plugin-panel-title" tabIndex={-1} onKeyDown={event => modalKeyDown(event, onClose)}>
        <header>
          <h2 id="plugin-panel-title">{text.title}</h2>
          <button ref={closeButton} type="button" onClick={onClose}>{text.close}</button>
        </header>
        <section>
          <p>{text.intro}</p>
          <p>{text.path}</p>
          {pending && <div className="plugin-command-list">
            <h3>{text.commands}</h3>
            <ul className="plugin-local-list" aria-label={text.commands}>
              {pending.manifest.commands.map((item, index) => <li key={`${index}:${item.command}`}>
                <button type="button" disabled={running} onClick={() => void runBundle(pending, warnings, item.command)}>{item.name}</button>
              </li>)}
            </ul>
          </div>}
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
                {PLUGIN_API_COVERAGE.map(entry => <tr key={entry.api}><td><code>{entry.api}</code></td><td>{entry.status}</td><td>{entry.notes}</td></tr>)}
              </tbody>
            </table>
          </details>
        </section>
        <footer>
          <button type="button" className="plugin-panel-primary" disabled={running} onClick={() => void runSample()}>{text.sample}</button>
          {desktop?.plugins ? <button type="button" disabled={running} onClick={() => void loadFolder()}>{text.load}</button> : null}
          <button type="button" disabled={running} onClick={() => archive.current?.click()}>{text.archive}</button>
          <input ref={archive} hidden type="file" accept=".zip,.figma,application/zip" data-testid="plugin-archive" onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void loadArchive(file)
          }} />
          <button type="button" disabled={!running} onClick={stop}>{text.stop}</button>
        </footer>
      </section>
    </div>
  )
}
