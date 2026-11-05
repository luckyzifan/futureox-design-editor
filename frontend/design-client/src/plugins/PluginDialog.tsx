import { useEffect, useRef, useState } from 'react'
import type { Editor } from '../engine'
import { createEditorDesignAutomation } from '../automation'
import { modalKeyDown } from '../modal-keyboard'
import { loadPluginFromFileList, loadPluginFromAddress } from './loader'
import { PluginHost, type PluginBundle } from './host'

interface LogEntry { level: 'info' | 'warn' | 'error'; message: string; at: number }
const MAX_LOGS = 300

/** 插件容器对话框：加载（本地 zip / 目录 / GitHub）→ 运行 → 观察日志与插件 UI。
 *
 * 插件以当前文档的共享 automation 权限运行（与 AI/MCP 同一提交边界）；
 * main 代码与 UI 分别运行在两个 sandbox iframe 中，与编辑器源隔离。
 */
export function PluginDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [bundle, setBundle] = useState<PluginBundle | null>(null)
  const [originInput, setOriginInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [uiSpec, setUiSpec] = useState<{ width: number; height: number; visible: boolean } | null>(null)
  const hostRef = useRef<PluginHost | null>(null)
  const uiAreaRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => { hostRef.current?.dispose(); hostRef.current = null }, [])

  const appendLog = (level: LogEntry['level'], message: string) =>
    setLogs(previous => [...previous.slice(-(MAX_LOGS - 1)), { level, message, at: Date.now() }])

  const stop = () => {
    hostRef.current?.dispose()
    hostRef.current = null
    setRunning(false)
    setUiSpec(null)
  }

  async function loadFromInput(kind: 'github' | 'zip' | 'folder', files?: FileList | null) {
    setError('')
    setLoading(true)
    try {
      let next: PluginBundle
      if (kind === 'github') next = await loadPluginFromAddress(originInput)
      else if (kind === 'zip' && files?.[0]) {
        const bytes = new Uint8Array(await files[0].arrayBuffer())
        next = await import('./loader').then(module => module.loadPluginFromZipBytes(bytes, files[0].name))
      } else if (files) next = await loadPluginFromFileList(files, 'local-folder')
      else throw new Error('未选择文件')
      stop()
      setBundle(next)
      setLogs([])
      appendLog('info', `已载入插件「${next.manifest.name}」（manifest v${next.manifest.manifestVersion}${next.manifest.version ? ` · ${next.manifest.version}` : ''}）来源：${next.origin}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }

  function run() {
    if (!bundle || !uiAreaRef.current) return
    setError('')
    stop()
    const api = createEditorDesignAutomation(editor)
    try {
      const host = new PluginHost(bundle, {
        editor,
        api,
        container: uiAreaRef.current!,
        events: {
          onLog: (level, message) => appendLog(level, message),
          onUi: update => {
            setUiSpec(previous => ({
              width: update.width ?? previous?.width ?? 300,
              height: update.height ?? previous?.height ?? 200,
              visible: update.visible ?? previous?.visible ?? true,
            }))
            const frame = host.uiFrameElement
            if (frame) {
              if (update.width) frame.style.width = `${update.width}px`
              if (update.height) frame.style.height = `${update.height}px`
              if (update.visible !== undefined) frame.style.display = update.visible ? 'block' : 'none'
            }
          },
          onNotify: message => editor.notify(message),
          onClose: message => { if (message) editor.notify(message) },
        },
      })
      hostRef.current = host
      setRunning(true)
      appendLog('info', `插件「${bundle.manifest.name}」已启动；操作通过共享编辑 API 提交。`)
    } catch (failure) {
      api.dispose()
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return <div className="modal-backdrop"><section className="remote-modal" role="dialog" aria-modal="true" aria-label="插件容器"
    style={{ width: 'min(760px,95vw)', maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}
    onKeyDown={event => modalKeyDown(event, onClose)}>
    <h2>插件容器 <button autoFocus aria-label="关闭插件面板" onClick={() => { stop(); onClose() }}>关闭</button></h2>
    <p>加载 Figma 插件（manifest v1/v2）在隔离沙箱中运行：main 代码无网络无 DOM，UI 独立 iframe；所有文档操作走共享编辑 API（可撤销）。P0 为最小 API 面，未覆盖的调用会在日志中列出。</p>
    <fieldset disabled={loading}>
      <legend>加载插件</legend>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ flex: 1, minWidth: 240 }} value={originInput} onChange={event => setOriginInput(event.target.value)}
          placeholder="GitHub 仓库地址（figma/plugin-samples/tree/main/post-message）或 .zip 直链" aria-label="插件仓库地址" />
        <button onClick={() => void loadFromInput('github')}>从 GitHub 载入</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>插件 zip<input type="file" accept=".zip" disabled={loading} onChange={event => { void loadFromInput('zip', event.currentTarget.files); event.currentTarget.value = '' }} /></label>
        <label>插件目录<input type="file" disabled={loading}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          multiple onChange={event => { void loadFromInput('folder', event.currentTarget.files); event.currentTarget.value = '' }} /></label>
      </div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {bundle && <fieldset>
      <legend>{bundle.manifest.name}{bundle.manifest.version ? ` · ${bundle.manifest.version}` : ''}</legend>
      <p>main：{bundle.manifest.main}{bundle.manifest.ui ? ` · ui：${bundle.manifest.ui}` : ' · 无 UI'} · manifest v{bundle.manifest.manifestVersion} · 来源 {bundle.origin}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {!running ? <button onClick={run}>运行插件</button> : <button onClick={stop}>停止插件</button>}
        {running && <span role="status" style={{ alignSelf: 'center' }}>运行中</span>}
      </div>
      <div ref={uiAreaRef} style={{ marginTop: 10, display: running && uiSpec ? 'block' : 'none' }} aria-label="插件界面区域" />
    </fieldset>}
    <fieldset style={{ minHeight: 120 }}><legend>插件日志{running ? '（运行中）' : ''}</legend>
      {logs.length === 0 ? <p role="status">暂无日志</p> : <div style={{ maxHeight: 200, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
        {logs.map((entry, index) => <p key={index} style={{
          margin: 0, whiteSpace: 'pre-wrap',
          color: entry.level === 'error' ? '#b91c1c' : entry.level === 'warn' ? '#92400e' : 'inherit',
        }}>{new Date(entry.at).toLocaleTimeString()} [{entry.level}] {entry.message}</p>)}
      </div>}
    </fieldset>
  </section></div>
}
