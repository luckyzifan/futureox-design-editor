import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../engine'
import { desktopBridge, type DesktopBridge, type PluginStorageOrigin } from '../desktop'
import { interfacePreference, useInterfacePreferences } from '../interface-preference'
import { figmaDevMode, useFigmaDevMode } from '../figma-dev-mode'
import { modalKeyDown, useModalOwnership } from '../modal-keyboard'
import { acceptedDeclaredPlugins, PLUGIN_HOST_EDITOR_TYPES, type DeclaredPlugin } from './catalog'
import { openPlugin, parsePluginManifest as parseRichManifest, pluginBundleFromZip, pluginEditorEvents, PluginApiError, PLUGIN_API_COVERAGE, type PluginBundle, type PluginCodegenOutput, type PluginController } from './rich-host'
import type { PluginStorageRequest } from './rich-host/client-storage'
import { pluginDocumentChanges } from './rich-host/document-changes'
import { PLUGIN_LIMITS } from './rich-host/limits'
import {
  assertPluginSource, missingPluginSource, pluginBundleFromSources, pluginEditorType, pluginLaunchContext, pluginUiPaths,
  type PluginEditorType, type PluginLaunchMode,
} from './rich-host/manifest'
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
    intro: '示例会在当前页面创建三个带标签的矩形。桌面版会扫描本机 plugins 文件夹。也可以手动加载含 manifest.json 的文件夹或 .zip / .figma 压缩包。',
    desktopUi: '插件界面在单独的沙箱窗口中打开。',
    webUi: '插件主程序已运行。插件界面窗口只在桌面版提供。',
    matrix: 'API 覆盖',
    path: '示例文件夹：frontend/design-client/plugins/labeled-rectangles',
    enabled: '本机插件',
    run: '运行',
    generate: '生成代码',
    codegen: '生成的代码',
    codegenEmpty: '选中一个图层后生成代码。',
    commands: '选择要运行的命令',
    none: '未找到本机插件。放入插件文件夹后重新打开此面板。',
    missing: '当前编辑模式无法运行这个本机插件。',
  },
  en: {
    title: 'Figma plugins',
    close: 'Close',
    sample: 'Run sample plugin',
    load: 'Load plugin folder…',
    archive: 'Load plugin archive…',
    stop: 'Stop plugin',
    intro: 'The sample creates three labeled rectangles on the current page. The desktop app scans its local plugins folder. You can also load a folder with manifest.json or a .zip / .figma archive.',
    desktopUi: 'The plugin interface opens in its own sandboxed window.',
    webUi: 'The plugin main script ran. The plugin UI window is available in the desktop app.',
    matrix: 'API coverage',
    path: 'Sample folder: frontend/design-client/plugins/labeled-rectangles',
    enabled: 'Local plugins',
    run: 'Run',
    generate: 'Generate code',
    codegen: 'Generated code',
    codegenEmpty: 'Select a layer to generate code.',
    commands: 'Choose a command',
    none: 'No local plugins found. Add a plugin folder and reopen this panel.',
    missing: 'That local plugin is unavailable in this editor mode.',
  },
} as const

export function PluginPanel({ editor, desktop = desktopBridge(), launch = null, onClose, returnFocus = null }: {
  editor: Editor
  desktop?: DesktopBridge
  launch?: { grant: string; token: number } | null
  onClose: () => void
  returnFocus?: HTMLElement | null
}) {
  const { locale, uiMode } = useInterfacePreferences()
  const devMode = useFigmaDevMode()
  const mode: PluginLaunchMode = uiMode === 'figma' && devMode ? 'inspect' : 'default'
  const editorType: PluginEditorType = pluginEditorType(mode)
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
  const [pending, setPending] = useState<{ bundle: PluginBundle; source?: PluginStorageOrigin; launch?: PluginLaunchMode } | null>(null)
  const [codegen, setCodegen] = useState<PluginCodegenOutput[]>([])
  const [enabled, setEnabled] = useState<DeclaredPlugin[] | null>(null)
  // The panel lists the plugins this editor context can launch. Every granted
  // declaration stays in the catalog so a menu launch can still explain a
  // FigJam, Slides, or Buzz manifest.
  const visible = enabled?.filter(plugin => plugin.editorType.includes(editorType)) ?? null
  const controller = useRef<PluginController | null>(null)
  const runAbort = useRef<AbortController | null>(null)
  const endStorage = useRef<(() => void) | null>(null)
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
  const lastMode = useRef(mode)

  function stop() {
    generation.current += 1
    runAbort.current?.abort()
    runAbort.current = null
    endStorage.current?.()
    endStorage.current = null
    controller.current?.close()
    controller.current = null
    uiOpen.current = false
    unlisten.current?.()
    unlisten.current = null
    void desktop?.plugins?.closeUi()
    setCodegen([])
    setRunning(false)
  }

  useEffect(() => stop, [desktop])
  stopRef.current = stop
  useEffect(() => {
    if (lastMode.current === mode) return
    lastMode.current = mode
    setPending(null)
    setStatus('')
    setError('')
    stopRef.current()
  }, [mode])

  useEffect(() => {
    if (typeof editor.subscribe !== 'function') return
    let watch = {
      pageId: editor.state.page, selection: editor.state.selection.join('\0'), revision: editor.state.version,
      documentId: editor.state.doc.id, session: editor.sessionGeneration,
      authored: editor.authoredDocument,
    }
    return editor.subscribe(() => {
      const next = {
        pageId: editor.state.page, selection: editor.state.selection.join('\0'), revision: editor.state.version,
        documentId: editor.state.doc.id, session: editor.sessionGeneration,
        authored: editor.authoredDocument,
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
      const failed = (failure: unknown) => {
        if (controller.current !== active) return
        setError(failure instanceof Error ? failure.message : String(failure))
        stopRef.current()
      }
      for (const event of events) {
        if (!active.watches(event)) continue
        try {
          const changes = event === 'documentchange' ? pluginDocumentChanges(previous.authored, next.authored) : undefined
          const delivered = active.emit(event, changes)
          if (delivered) void delivered.catch(failed)
        } catch (failure) { failed(failure) }
      }
      if (active.mode === 'codegen' && next.selection !== previous.selection) {
        try {
          void active.requestCodegen().then(requested => {
            if (controller.current === active && !requested) setCodegen([{ sections: [] }])
          }).catch(failed)
        } catch (failure) { failed(failure) }
      }
    })
  }, [editor])

  useEffect(() => {
    const list = desktop?.plugins?.list
    if (!list) return
    let live = true
    void list().then(result => {
      if (!live) return
      if (result.status === 'ok') setEnabled(acceptedDeclaredPlugins(result.plugins, PLUGIN_HOST_EDITOR_TYPES))
      else if (result.status === 'error' || result.status === 'conflict') { setEnabled([]); setError(result.message) }
      else setEnabled([])
    }).catch(cause => {
      if (live) { setEnabled([]); setError(cause instanceof Error ? cause.message : String(cause)) }
    })
    return () => { live = false }
  }, [desktop, editorType])

  async function run(manifestText: string, mainSource: string, uiHtml: string, notes: string[], command?: string) {
    try {
      const manifest = parseRichManifest(JSON.parse(manifestText))
      await runBundle({ manifest, main: mainSource, ui: uiHtml || null }, notes, { sample: true }, command)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      stop()
    }
  }

  async function runBundle(bundle: PluginBundle, notes: string[], source?: PluginStorageOrigin, command?: string, launch: PluginLaunchMode = mode) {
    stop()
    const token = generation.current
    setError('')
    setWarnings(notes)
    try { pluginLaunchContext(bundle.manifest, launch) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    // A manifest menu is a choice. Loading the file must not run commands[0].
    if (command === undefined && bundle.manifest.commands.length > 0) {
      setPending({ bundle, source, launch })
      setStatus('')
      setRunning(false)
      return
    }
    setPending(null)
    setRunning(true)
    const abort = new AbortController()
    runAbort.current = abort
    const failed = (failure: unknown) => {
      if (token !== generation.current) return
      setError(failure instanceof Error ? failure.message : String(failure))
      stop()
    }
    try {
      const manifest = bundle.manifest
      const nativeStorage = desktop?.plugins?.storage
      let storageRequest: PluginStorageRequest | undefined
      if (nativeStorage) {
        if (!source) throw new PluginApiError('storage_failed', 'Plugin storage needs an authorized package')
        const opened = await nativeStorage.begin({ source })
        if (opened.status !== 'ok') throw new PluginApiError('storage_failed', 'Could not open plugin storage')
        const lease = opened.token
        const end = () => { void nativeStorage.end({ token: lease }).catch(() => {}) }
        if (token !== generation.current) { end(); return }
        endStorage.current = end
        storageRequest = async operation => {
          const saved = await nativeStorage.call({ token: lease, operation })
          if (saved.status === 'ok') return saved.value
          if (saved.status === 'cancelled') throw new PluginApiError('storage_failed', 'Plugin storage request cancelled')
          const code = saved.code === 'PLUGIN_STORAGE_LIMIT' ? 'plugin_limit' : 'storage_failed'
          throw new PluginApiError(code, saved.message)
        }
      }
      const next = await openPlugin(editor, bundle, {
        command,
        mode: launch,
        isModeCurrent: () => mode === (interfacePreference.getSnapshot().uiMode === 'figma' && figmaDevMode() ? 'inspect' : 'default'),
        onCodegen: output => { if (token === generation.current) setCodegen([output]) },
        signal: abort.signal,
        onError: failed,
        storageRequest,
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
            void desktop.plugins.openUi({
              html: ui.html, width: ui.width, height: ui.height, title: ui.title,
              ...(manifest.uiNetworkDomains ? { allowedDomains: manifest.uiNetworkDomains } : {}),
            }).then(opened => {
              if (token !== generation.current) return
              if (opened.status === 'error') setError(opened.message)
              else setStatus(text.desktopUi)
            })
          } else setStatus(text.webUi)
        },
        onPostMessage: message => {
          if (token === generation.current) void desktop?.plugins?.postUi({ pluginMessage: message })
        },
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
      if (next.mode === 'codegen') void next.requestCodegen().then(requested => {
        if (token === generation.current && !requested) setCodegen([{ sections: [] }])
      }).catch(failed)
      if (desktop?.plugins) {
        const offMessage = desktop.plugins.onUiMessage(message => {
          if (token !== generation.current) return
          try {
            const delivered = next.deliver(message.pluginMessage)
            if (delivered) void delivered.catch(failed)
          } catch (failure) { failed(failure) }
        })
        const offClosed = desktop.plugins.onUiClosed(() => { if (token === generation.current) stop() })
        unlisten.current = () => { offMessage(); offClosed() }
      }
    } catch (cause) { failed(cause) }
  }

  async function runSample() {
    await run(samplePlugin.manifestText, samplePlugin.mainSource, samplePlugin.uiHtml, [], 'run')
  }

  async function runManifest(grant: string, manifestText: string, launch: PluginLaunchMode = mode) {
    const plugins = desktop?.plugins
    if (!plugins) return
    const manifest = parseRichManifest(JSON.parse(manifestText), { desktopFolder: true })
    const paths = [manifest.main, ...pluginUiPaths(manifest)]
    const files = new Map<string, string>()
    let remaining = PLUGIN_LIMITS.uiBytes
    for (let first = 0; first < paths.length; first += 2) {
      const requested = paths.slice(first, first + 2)
      const read = await plugins.read({ grant, paths: requested })
      if (read.status === 'cancelled') return
      if (read.status !== 'ok') { setError(read.message); return }
      for (const path of requested) {
        const content = read.files[path]
        if (typeof content !== 'string') throw missingPluginSource(manifest, path)
        if (path !== manifest.main) remaining -= assertPluginSource(content, path, remaining)
        files.set(path, content)
      }
    }
    await runBundle(pluginBundleFromSources(manifest, files), [], { folderGrant: grant }, undefined, launch)
  }

  async function runListed(plugin: DeclaredPlugin, launch: PluginLaunchMode = mode) {
    try { await runManifest(plugin.grant, plugin.manifestText, launch) }
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
      const bytes = new Uint8Array(await file.arrayBuffer())
      const compileSource = desktop?.plugins?.compileSource
      const bundle = compileSource ? await pluginBundleFromZip(bytes, async source => {
        const compiled = await compileSource({ source })
        if (compiled.status === 'ok') return compiled.script
        throw new PluginApiError('invalid_plugin', compiled.status === 'cancelled' ? 'Plugin source compilation cancelled' : compiled.message)
      }) : pluginBundleFromZip(bytes)
      let source: PluginStorageOrigin | undefined
      if (desktop?.plugins?.storage) {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        source = { archiveDigest: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') }
      }
      await runBundle(bundle, [], source)
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
              {pending.bundle.manifest.commands.map((item, index) => <li key={`${index}:${item.command}`}>
                <button type="button" disabled={running} onClick={() => void runBundle(pending.bundle, warnings, pending.source, item.command, pending.launch)}>{item.name}</button>
              </li>)}
            </ul>
          </div>}
          {visible && visible.length > 0 ? (
            <div>
              <h3>{text.enabled}</h3>
              <ul className="plugin-local-list" aria-label={text.enabled}>
                {visible.map(plugin => (
                  <li key={plugin.grant}>
                    <span>{plugin.name}</span>
                    <button type="button" disabled={running} onClick={() => void runListed(plugin)}>{text.run}</button>
                    {mode !== 'default' && plugin.capabilities.includes('codegen')
                      ? <button type="button" disabled={running} onClick={() => void runListed(plugin, 'codegen')}>{text.generate}</button>
                      : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : visible ? <p>{text.none}</p> : null}
          {warnings.map(warning => <p key={warning}>{warning}</p>)}
          {codegen.length ? <section className="plugin-codegen" aria-label={text.codegen}>
            <h3>{text.codegen}</h3>
            {codegen.map((output, index) => <div key={index}>
              {output.error ? <p role="alert">{output.error}</p> : null}
              {output.sections.map((section, sectionIndex) => <div key={sectionIndex}>
                <strong>{section.title || section.language}</strong>
                <pre><code>{section.code}</code></pre>
              </div>)}
            </div>)}
            {codegen.every(output => !output.error && !output.sections.length) ? <p>{text.codegenEmpty}</p> : null}
          </section> : null}
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
          <button type="button" className="plugin-panel-primary" disabled={running || mode === 'inspect'} onClick={() => void runSample()}>{text.sample}</button>
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
