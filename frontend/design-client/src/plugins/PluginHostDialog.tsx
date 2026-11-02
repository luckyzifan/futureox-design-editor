import { useEffect, useRef, useState } from 'react'
import './plugin-host.css'
import code from '../../plugins/labeled-rectangles/code.js?raw'
import ui from '../../plugins/labeled-rectangles/ui.html?raw'
import manifestSource from '../../plugins/labeled-rectangles/manifest.json?raw'
import { pluginErrorMessage } from './errors'
import { bundleFromTextFiles, bundleFromZip, type PluginBundle } from './manifest'
import { readPluginMessage, wrapPluginUi, type PluginUiOptions } from './messages'
import type { PluginController, PluginEditor } from './runtime'

const sampleBundle: PluginBundle = { ...bundleFromTextFiles([
  { name: 'manifest.json', text: manifestSource },
  { name: 'code.js', text: code },
  { name: 'ui.html', text: ui },
]), }

export function PluginHostDialog({ editor, locale, onClose }: { editor: PluginEditor; locale: 'zh-CN' | 'en'; onClose: () => void }) {
  const en = locale === 'en'
  const text = en ? english : chinese
  const [bundle, setBundle] = useState<PluginBundle>(sampleBundle)
  const [command, setCommand] = useState(sampleBundle.manifest.menu[0]?.command ?? 'run')
  const [status, setStatus] = useState(text.idle)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uiState, setUiState] = useState<PluginUiOptions | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<PluginController | null>(null)
  const queued = useRef<unknown[]>([])
  const frameReady = useRef(false)
  const pluginId = bundle.manifest.id

  const postToUi = (message: unknown) => {
    const target = frame.current?.contentWindow
    if (!frameReady.current || !target) {
      queued.current.push(message)
      return
    }
    target.postMessage({ pluginId, pluginMessage: message }, '*')
  }
  const flushUi = () => {
    frameReady.current = true
    const target = frame.current?.contentWindow
    if (!target) return
    for (const message of queued.current) target.postMessage({ pluginId, pluginMessage: message }, '*')
    queued.current = []
  }

  useEffect(() => () => { void controller.current?.stop() }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      try {
        const message = readPluginMessage(event.data)
        if (!message) return
        void controller.current?.deliver(message.pluginMessage)
      } catch (caught) {
        setError(pluginErrorMessage(caught))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const run = async (next: PluginBundle, nextCommand: string) => {
    setBusy(true)
    setError('')
    frameReady.current = false
    queued.current = []
    setUiState(null)
    setStatus(en ? `Running ${next.manifest.name}…` : `正在运行 ${next.manifest.name}…`)
    await controller.current?.stop()
    try {
      const runtime = await import('./runtime')
      controller.current = await runtime.launchPlugin(editor, next, nextCommand, {
        onUi: uiOptions => { frameReady.current = false; setUiState(uiOptions) },
        onResize: size => setUiState(current => current ? { ...current, ...size } : current),
        onPluginMessage: message => { postToUi(message) },
      })
      setStatus(controller.current.closed ? text.finished : text.listening)
    } catch (caught) {
      setError(pluginErrorMessage(caught))
      setStatus(text.failed)
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop"><section className="remote-modal plugin-host-dialog" role="dialog" aria-modal="true" aria-label={text.title} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <h2>{text.title} <button autoFocus type="button" aria-label={text.close} onClick={onClose}>{text.close}</button></h2>
    <p>{text.intro}</p>
    <div className="plugin-host-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => { setBundle(sampleBundle); setCommand('run'); void run(sampleBundle, 'run') }}>{text.sample}</button>
      <label>{text.folder} <input aria-label={text.folder} type="file" disabled={busy} multiple {...{ webkitdirectory: '', directory: '' }} onChange={event => void loadFiles(event.currentTarget.files, false, setBundle, setCommand, setError)} /></label>
      <label>{text.zip} <input aria-label={text.zip} type="file" accept=".zip,application/zip" disabled={busy} onChange={event => void loadFiles(event.currentTarget.files, true, setBundle, setCommand, setError)} /></label>
      <button type="button" disabled={busy || !controller.current || controller.current.closed} onClick={() => void controller.current?.stop().then(() => setStatus(text.finished))}>{text.stop}</button>
    </div>
    <div className="plugin-host-commands" role="group" aria-label={text.commands}>
      {bundle.manifest.menu.map(item => <button type="button" key={item.command} disabled={busy} aria-pressed={command === item.command} onClick={() => { setCommand(item.command); void run(bundle, item.command) }}>{item.name}</button>)}
    </div>
    <p className="plugin-host-log" role="status">{bundle.manifest.name} · {bundle.manifest.id}{bundle.manifest.networkAccess.requested.length ? ` · ${text.network}` : ''}</p>
    <p className="plugin-host-log" role="status">{status}</p>
    {error ? <p role="alert">{error}</p> : null}
    {uiState ? <div className="plugin-host-ui"><iframe ref={frame} title={uiState.title || bundle.manifest.name} sandbox="allow-scripts" style={{ height: uiState.height }} srcDoc={wrapPluginUi(uiState.html)} onLoad={flushUi} /></div> : null}
  </section></div>
}

async function loadFiles(list: FileList | null, zip: boolean, setBundle: (bundle: PluginBundle) => void, setCommand: (command: string) => void, setError: (message: string) => void) {
  const file = list?.[0]
  if (!list || !file) return
  try {
    const bundle = zip ? bundleFromZip(new Uint8Array(await file.arrayBuffer())) : await filesFromList(list)
    setBundle(bundle)
    setCommand(bundle.manifest.menu[0]?.command ?? 'run')
    setError('')
  } catch (caught) {
    setError(pluginErrorMessage(caught))
  }
}

async function filesFromList(list: FileList): Promise<PluginBundle> {
  const files = await Promise.all([...list].map(async file => ({ name: file.webkitRelativePath || file.name, text: await file.text() })))
  return bundleFromTextFiles(files)
}

const english = {
  title: 'Figma plugins',
  close: 'Close plugins',
  intro: 'Run a Figma plugin main script against this document. Creates, transforms, and hit-testing go through the Rust kernel. The UI is a sandboxed frame with no network.',
  sample: 'Run sample plugin',
  folder: 'Load plugin folder',
  zip: 'Load plugin zip',
  stop: 'Stop',
  commands: 'Plugin commands',
  network: 'network access requested and not granted',
  idle: 'Choose a plugin. One turn is one undo step.',
  listening: 'Plugin UI is listening.',
  finished: 'Plugin finished. Undo removes its committed turns.',
  failed: 'Plugin failed.',
}
const chinese = {
  title: 'Figma 插件',
  close: '关闭插件',
  intro: '在当前文档上运行 Figma 插件主脚本。创建、变换和命中测试走 Rust 内核。界面在无网络的沙箱框架里。',
  sample: '运行示例插件',
  folder: '加载插件文件夹',
  zip: '加载插件 zip',
  stop: '停止',
  commands: '插件命令',
  network: '清单请求了网络，当前不会放行',
  idle: '选择一个插件。每一轮提交是一步撤销。',
  listening: '插件界面正在等待操作。',
  finished: '插件已结束。撤销可以去掉它提交的修改。',
  failed: '插件运行失败。',
}
