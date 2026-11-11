import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  assetBatchSummary,
  assetBatchZip,
  assetManifest,
  enumerateAssetTasks,
  filterAssetTasks,
  mergeAssetStates,
  runAssetBatch,
  type AssetBatchResult,
  type AssetFile,
  type AssetTask,
  type AssetTaskState,
} from './asset-batch'
import { desktopBridge, type DesktopBridge } from './desktop'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown } from './modal-keyboard'
import { download } from './persistence'
import './asset-export.css'

type Ready = AssetBatchResult & { urls: { taskId: string; url: string }[] }

function fileBlob(bytes: Uint8Array, type: string) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type })
}

function rememberUrl(file: AssetFile, urls: { taskId: string; url: string }[]) {
  try {
    const url = URL.createObjectURL(fileBlob(file.bytes, file.mime))
    urls.push({ taskId: file.taskId, url })
  } catch { /* The bytes remain available for ZIP and directory delivery. */ }
}

function release(ready: Ready | null) {
  if (!ready) return
  for (const item of ready.urls) {
    try { URL.revokeObjectURL(item.url) } catch { /* The URL was already released. */ }
  }
}

export function AssetExportDialog({ editor, onClose, run = runAssetBatch, deliverFiles = download }: {
  editor: Editor
  onClose: () => void
  run?: typeof runAssetBatch
  deliverFiles?: (name: string, blob: Blob) => void
}) {
  const snap = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const { locale, uiMode } = useInterfacePreferences()
  const tx = (zh: string, en: string) => locale === 'en' ? en : zh
  const tasks = useMemo(() => enumerateAssetTasks(snap.doc, snap.page, snap.version), [snap.doc, snap.page, snap.version])
  const [layer, setLayer] = useState('')
  const [format, setFormat] = useState('')
  const [scale, setScale] = useState('')
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({})
  const [ready, setReady] = useState<Ready | null>(null)
  const [busy, setBusy] = useState(false)
  const [deliveryNote, setDeliveryNote] = useState('')
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const readyRef = useRef<Ready | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const checked = (task: AssetTask) => overrides[task.id] ?? task.executable
  const filtered = filterAssetTasks(tasks, { layer, format, scale })
  const selected = tasks.filter(checked)
  const formats = [...new Set(tasks.map(task => task.format))]
  const scales = [...new Set(tasks.map(task => String(task.scale)))].sort((a, b) => Number(a) - Number(b))
  const summary = ready ? assetBatchSummary(ready.manifest, locale) : ''
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = [...document.body.children].filter(element => element !== backdrop.current).map(element => ({ element, inert: element.getAttribute('inert') }))
    background.forEach(({ element }) => element.setAttribute('inert', ''))
    search.current?.focus()
    return () => {
      background.forEach(({ element, inert }) => inert === null ? element.removeAttribute('inert') : element.setAttribute('inert', inert))
      release(readyRef.current)
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  function toggle(task: AssetTask, value: boolean) {
    setOverrides(previous => ({ ...previous, [task.id]: value }))
    setDeliveryNote('')
  }
  function toggleFiltered(value: boolean) {
    setOverrides(previous => {
      const next = { ...previous }
      for (const task of filtered) next[task.id] = value
      return next
    })
    setDeliveryNote('')
  }
  function requestClose() {
    if (busyRef.current) {
      abortRef.current?.abort()
      return
    }
    onClose()
  }
  function adopt(result: AssetBatchResult, previous: Ready | null) {
    const urls: Ready['urls'] = []
    for (const file of result.files) rememberUrl(file, urls)
    const next = { ...result, urls }
    release(previous)
    readyRef.current = next
    setReady(next)
    return next
  }
  async function execute(list: AssetTask[], previous: Ready | null) {
    if (editor.propertyPreviewActive) {
      setDeliveryNote(tx('请先完成或取消当前属性预览，再导出资源。', 'Finish or cancel the property preview before exporting assets.'))
      return null
    }
    if (!list.length) {
      setDeliveryNote(tx('请至少选择一个预设。', 'Choose at least one preset.'))
      return null
    }
    const state = editor.state
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setDeliveryNote('')
    const stop = editor.subscribe(() => {
      const now = editor.state
      if (now.version !== state.version || now.page !== state.page || now.doc.id !== state.doc.id) controller.abort()
    })
    try {
      const result = await run({
        document: state.doc,
        pageId: state.page,
        revision: state.version,
        tasks: list,
        encoding: '',
        signal: controller.signal,
        onUpdate: () => {},
      })
      if (previous) {
        const ids = new Set([...previous.manifest.tasks.map(task => task.taskId), ...list.map(task => task.id)])
        const scope = tasks.filter(task => ids.has(task.id))
        const merged = mergeAssetStates(scope, previous.manifest.tasks, result.manifest.tasks)
        const files = mergeFiles(previous.files, result.files, merged)
        const manifest = assetManifest({
          documentId: state.doc.id,
          pageId: state.page,
          revision: state.version,
          tasks: merged.map(task => task.status === 'succeeded' && !files.some(file => file.taskId === task.taskId && file.path === task.path)
            ? { ...task, status: 'failed', error: '导出结果为空' }
            : task),
        })
        return adopt({ manifest, files: files.filter(file => manifest.tasks.some(task => task.taskId === file.taskId && task.status === 'succeeded' && task.path === file.path)) }, previous)
      }
      return adopt(result, null)
    } catch (error) {
      const tasks = list.map(task => ({
        taskId: task.id, nodeId: task.nodeId, settingId: task.settingId, revision: task.revision,
        format: task.format, scale: task.scale, suffix: task.suffix, path: task.path,
        status: controller.signal.aborted ? 'cancelled' as const : 'failed' as const,
        ...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
      }))
      const manifest = assetManifest({ documentId: state.doc.id, pageId: state.page, revision: state.version, tasks })
      return adopt({ manifest, files: [] }, previous)
    } finally {
      stop()
      abortRef.current = null
      busyRef.current = false
      setBusy(false)
    }
  }
  async function renderSelected() {
    const current = tasks.filter(checked)
    return execute(current, null)
  }
  async function retry(ids: readonly string[]) {
    const current = tasks.filter(task => ids.includes(task.id))
    await execute(current, ready)
  }
  function filesOf(result: Ready) {
    return result.files
  }
  async function downloadFiles(result: Ready) {
    const manifest = result.manifest
    for (const file of filesOf(result)) deliverFiles(file.path, fileBlob(file.bytes, file.mime))
    deliverFiles(assetManifestName(), new Blob([JSON.stringify(manifest)], { type: 'application/json' }))
    const complete = manifest.complete && result.files.length === manifest.fileCount && manifest.fileCount === selected.length
    setDeliveryNote(complete
      ? tx(`已开始下载 ${manifest.fileCount} 个文件。`, `Started downloading ${manifest.fileCount} files.`)
      : tx(`下载未完成：已交出 ${result.files.length} 个文件。`, `Download is not complete: handed off ${result.files.length} files.`))
  }
  async function downloadZip(result: Ready) {
    const bytes = assetBatchZip(result.files, result.manifest)
    const bridge = desktopBridge()
    if (bridge?.exportAssetZip) {
      const response = await bridge.exportAssetZip({
        filename: zipName(snap.doc.name),
        files: result.files.map(file => ({ name: file.path, bytes: file.bytes })),
        manifest: result.manifest,
      })
      const complete = response.status === 'ok' && response.complete && response.fileCount === result.manifest.fileCount && result.manifest.complete
      setDeliveryNote(response.status === 'cancelled'
        ? tx('ZIP 未写入。', 'The ZIP was not written.')
        : response.status === 'error'
          ? response.message
          : complete
            ? tx(`已写入 ZIP ${response.displayName}，${response.fileCount} 个文件。`, `Wrote ZIP ${response.displayName}, ${response.fileCount} files.`)
            : tx(`ZIP 未完成：写入 ${response.status === 'ok' ? response.fileCount : 0} 个文件。`, `ZIP is not complete: wrote ${response.status === 'ok' ? response.fileCount : 0} files.`))
      return
    }
    deliverFiles(zipName(snap.doc.name), fileBlob(bytes, 'application/zip'))
    const complete = result.manifest.complete && result.files.length === result.manifest.fileCount
    setDeliveryNote(complete
      ? tx(`已开始下载 ZIP，${result.manifest.fileCount} 个文件。`, `Started downloading a ZIP of ${result.manifest.fileCount} files.`)
      : tx(`ZIP 未完成：包含 ${result.files.length} 个文件。`, `ZIP is not complete: it contains ${result.files.length} files.`))
  }
  async function writeDirectory(result: Ready) {
    const bridge: DesktopBridge | undefined = desktopBridge()
    if (!bridge?.exportAssetDirectory) {
      setDeliveryNote(tx('当前环境不能选择文件夹。可以下载文件或 ZIP。', 'This environment cannot choose a folder. Download the files or a ZIP instead.'))
      return
    }
    const response = await bridge.exportAssetDirectory({
      files: result.files.map(file => ({ name: file.path, bytes: file.bytes })),
      manifest: result.manifest,
    })
    if (response.status === 'cancelled') {
      setDeliveryNote(tx('文件夹未写入。', 'The folder was not written.'))
      return
    }
    if (response.status !== 'ok') {
      setDeliveryNote(response.message)
      return
    }
    const tasks = result.manifest.tasks.map(task => {
      if (task.status !== 'succeeded') return task
      const item = response.results.find(entry => entry.name === task.path)
      if (item?.written) return task
      return { ...task, status: 'failed' as const, error: item?.reason === 'exists' ? tx('目标位置已有同名文件', 'A file with this name is already in the folder') : tx('文件没有写入', 'The file was not written') }
    })
    let manifest = assetManifest({ documentId: result.manifest.documentId, pageId: result.manifest.pageId, revision: result.manifest.revision, tasks })
    if (response.fileCount !== manifest.fileCount || response.complete !== manifest.complete) {
      manifest = assetManifest({
        documentId: manifest.documentId, pageId: manifest.pageId, revision: manifest.revision,
        tasks: manifest.tasks.map(task => task.status === 'succeeded' ? { ...task, status: 'failed', error: tx('写入结果与清单不一致', 'The written file count does not match the manifest') } : task),
      })
    }
    const files = result.files.filter(file => manifest.tasks.some(task => task.status === 'succeeded' && task.taskId === file.taskId && task.path === file.path))
    adopt({ manifest, files }, result)
    const complete = manifest.complete && response.complete && response.fileCount === manifest.fileCount
    setDeliveryNote(complete
      ? tx(`已写入文件夹 ${response.fileCount} 个文件。`, `Wrote ${response.fileCount} files to the folder.`)
      : tx(`文件夹未完成：写入 ${response.fileCount} 个文件。`, `The folder is not complete: wrote ${response.fileCount} files.`))
  }
  async function deliver(mode: 'download' | 'zip' | 'directory') {
    const current = tasks.filter(checked)
    const fresh = ready && covers(ready, current) ? ready : await execute(current, null)
    if (!fresh) return
    if (mode === 'download') await downloadFiles(fresh)
    else if (mode === 'zip') await downloadZip(fresh)
    else await writeDirectory(fresh)
  }

  return createPortal(<div className="asset-export-backdrop" data-ui-mode={uiMode} ref={backdrop} onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) requestClose() }} onWheel={event => event.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-busy={busy} aria-label={tx('全部资源', 'All assets')} className="asset-export-panel" tabIndex={-1} onKeyDown={event => modalKeyDown(event, requestClose)}>
      <header>
        <strong>{tx('全部资源', 'All assets')}</strong>
        <button type="button" onClick={requestClose}>{tx('关闭', 'Close')}</button>
      </header>
      <p>{tx('按当前页面每个图层已有的预设分别导出。打开这个列表不会修改预设、图层或历史。合并选区仍在导出图像里。', 'Exports each existing layer preset on this page separately. Opening this list does not change presets, layers, or history. Merged selection stays in Export.')}</p>
      <div className="asset-export-filters">
        <input ref={search} aria-label={tx('按图层筛选', 'Filter by layer')} placeholder={tx('图层或文件名', 'Layer or file name')} value={layer} onChange={event => setLayer(event.target.value)} />
        <select aria-label={tx('按格式筛选', 'Filter by format')} value={format} onChange={event => setFormat(event.target.value)}>
          <option value="">{tx('全部格式', 'All formats')}</option>
          {formats.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select aria-label={tx('按倍率筛选', 'Filter by scale')} value={scale} onChange={event => setScale(event.target.value)}>
          <option value="">{tx('全部倍率', 'All scales')}</option>
          {scales.map(item => <option key={item} value={item}>{item}x</option>)}
        </select>
        <label><input type="checkbox" aria-label={tx('选择筛选结果', 'Select filtered presets')} checked={filtered.length > 0 && filtered.every(checked)} onChange={event => toggleFiltered(event.target.checked)} />{tx('选择筛选结果', 'Select filtered')}</label>
      </div>
      <ul className="asset-export-list" aria-label={tx('图层预设', 'Layer presets')}>
        {filtered.map(task => {
          const state = matchingState(ready?.manifest.tasks, task)
          return <li key={task.id} data-task-id={task.id} data-status={state?.status ?? 'pending'}>
            <label className="asset-export-row">
              <input type="checkbox" aria-label={tx(`选择 ${task.nodeName} ${task.format} ${task.scale} ${task.suffix || '无后缀'}`, `Select ${task.nodeName} ${task.format} ${task.scale} ${task.suffix || 'no suffix'}`)} checked={checked(task)} onChange={event => toggle(task, event.target.checked)} />
              <span>{task.nodeName}</span>
              <span>{task.format}</span>
              <span>{task.scale}x</span>
              <span>{task.suffix || tx('无后缀', 'no suffix')}</span>
              <span className="asset-export-path">{task.path}</span>
            </label>
            <span>{rowStatus(task, state, tx)}</span>
            {state && state.status !== 'succeeded' && <button type="button" disabled={busy} onClick={() => void retry([task.id])}>{tx('重试', 'Retry')}</button>}
            {state?.status === 'succeeded' && ready?.urls.find(item => item.taskId === task.id)?.url && <a href={ready.urls.find(item => item.taskId === task.id)?.url} download={task.path}>{tx('下载', 'Download')} {task.path}</a>}
          </li>
        })}
        {!filtered.length && <li>{tx('当前页面没有匹配的图层预设。', 'No matching layer presets on this page.')}</li>}
      </ul>
      <div className="asset-export-actions">
        <button type="button" disabled={busy || !selected.length} onClick={() => void renderSelected()}>{busy ? tx('正在导出…', 'Exporting…') : tx(`导出所选 ${selected.length}`, `Export selected ${selected.length}`)}</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => void deliver('download')}>{tx('下载所选', 'Download selected')}</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => void deliver('zip')}>{tx('下载 ZIP', 'Download ZIP')}</button>
        <button type="button" disabled={busy || !selected.length || !desktopBridge()?.exportAssetDirectory} title={desktopBridge()?.exportAssetDirectory ? undefined : tx('桌面端可以选择文件夹', 'The desktop app can choose a folder')} onClick={() => void deliver('directory')}>{tx('写入文件夹…', 'Write to folder…')}</button>
        {busy && <button type="button" onClick={() => abortRef.current?.abort()}>{tx('取消', 'Cancel')}</button>}
        {ready && ready.manifest.tasks.some(task => task.status !== 'succeeded') && <button type="button" disabled={busy} onClick={() => void retry(ready.manifest.tasks.filter(task => task.status !== 'succeeded').map(task => task.taskId))}>{tx('重试失败项', 'Retry failed')}</button>}
      </div>
      <p role="status" data-kind="batch">{summary}</p>
      <p role="status" data-kind="delivery">{deliveryNote}</p>
    </section>
  </div>, document.body)
}

function assetManifestName() {
  return 'asset-manifest.json'
}

function covers(result: Ready, selected: readonly AssetTask[]) {
  if (result.manifest.tasks.length !== selected.length) return false
  return selected.every(task => result.manifest.tasks.some(state => sameIdentity(state, task)))
}

function sameIdentity(state: AssetTaskState, task: AssetTask) {
  return state.taskId === task.id && state.revision === task.revision && state.path === task.path
    && state.format === task.format && state.scale === task.scale && state.suffix === task.suffix
}

function matchingState(states: readonly AssetTaskState[] | undefined, task: AssetTask) {
  const state = states?.find(item => sameIdentity(item, task))
  return state
}

function mergeFiles(previous: readonly AssetFile[], next: readonly AssetFile[], states: readonly AssetTaskState[]) {
  const byId = new Map<string, AssetFile>()
  for (const file of previous) byId.set(file.taskId, file)
  for (const file of next) byId.set(file.taskId, file)
  return states.filter(state => state.status === 'succeeded').flatMap(state => {
    const file = byId.get(state.taskId)
    return file && file.path === state.path ? [file] : []
  })
}

function zipName(documentName: string) {
  const stem = Array.from(documentName, character => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160) || 'design'
  return `${stem}-assets.zip`
}

function rowStatus(task: AssetTask, state: AssetTaskState | undefined, tx: (zh: string, en: string) => string) {
  if (!state) return task.blockReason ?? tx('待导出', 'Not exported')
  if (state.status === 'succeeded') return tx('成功', 'Succeeded')
  if (state.status === 'cancelled') return tx('已取消', 'Cancelled')
  return tx(`失败：${state.error || '导出失败'}`, `Failed: ${state.error || 'Export failed'}`)
}
