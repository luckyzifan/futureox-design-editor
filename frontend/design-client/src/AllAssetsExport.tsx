import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  planAllAssets,
  type AllAssetScope,
  type AllAssetTask,
} from './all-assets-plan'
import {
  allAssetsStatusText,
  allAssetsZip,
  bytesBlob,
  mergeAllAssetRuns,
  runAllAssets,
  type AllAssetEncoder,
  type AllAssetRun,
} from './all-assets-run'
import { commitExportEdits } from './export-ownership'
import { subtreeNeedsExplicitColorEncoding } from './export-metadata'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { download } from './persistence'

const messageEnglish: Record<string, string> = {
  '与其他所选预设的文件名冲突，未写入': 'This file name collides with another selected preset, so nothing was written.',
  '批量导出总尺寸超过 6400 万像素，请拆分批次': 'The combined export exceeds 64 million pixels. Split the batch.',
  '已取消导出': 'Export cancelled',
  '请选择当前页面的 1–1000 个可见图层': 'Choose 1–1000 visible layers on the current page.',
  '包含仅用于 Sketch 往返的格式或零倍率设置；请改用可执行格式和正倍率': 'This preset is only for Sketch round-trip. Choose an executable format and a positive scale.',
  '广色域 / HDR 或负值分量需要先明确选择输出编码；图层预设不会静默裁成 8 位': 'Wide-gamut, HDR, or negative channels need an output encoding first. Layer presets are not silently clipped to 8-bit.',
  '导出结果为空': 'The export was empty.',
  '图层不存在': 'The layer is missing.',
}

function formatLabel(format: AllAssetTask['format'], english: boolean): string {
  if (format === 'pdf-vector') return english ? 'PDF · vector' : 'PDF · 矢量'
  if (format === 'pdf') return english ? 'PDF · bitmap' : 'PDF · 位图'
  if (format === 'jpg') return 'JPG'
  if (format === 'jpeg') return 'JPEG'
  if (format === 'webp') return 'WebP'
  return format.toUpperCase()
}

function defaultChecked(tasks: readonly AllAssetTask[]): Set<string> {
  return new Set(tasks.filter(task => task.executable).map(task => task.id))
}

export function AllAssetsExport({ editor, encode }: { editor: Editor; encode?: AllAssetEncoder }) {
  const { locale } = useInterfacePreferences()
  const english = locale === 'en'
  const text = (zh: string, en: string) => english ? en : zh
  const snap = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const [scope, setScope] = useState<AllAssetScope>('page')
  const [query, setQuery] = useState('')
  const [formatFilter, setFormatFilter] = useState('all')
  const [scaleFilter, setScaleFilter] = useState('all')
  const [encoding, setEncoding] = useState<'srgb' | 'display-p3' | ''>('')
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<AllAssetRun | null>(null)
  const [progress, setProgress] = useState('')
  const plan = useMemo(
    () => planAllAssets(snap.doc, { scope, pageId: snap.page, revision: snap.version }),
    [snap.doc, snap.page, snap.version, scope],
  )
  const planKey = `${plan.documentId}:${plan.revision}:${plan.scope}:${plan.pageId}:${plan.tasks.map(task => `${task.id}:${task.executable}:${task.path}`).join('|')}`
  const [checkedKey, setCheckedKey] = useState(planKey)
  const [checked, setChecked] = useState<Set<string>>(() => defaultChecked(plan.tasks))
  if (checkedKey !== planKey) {
    setCheckedKey(planKey)
    setChecked(defaultChecked(plan.tasks))
  }
  const needsChoice = useMemo(() => {
    const ids = new Set<string>()
    if (!snap.doc.colorManagement) return ids
    for (const task of plan.tasks) {
      if (task.executable && subtreeNeedsExplicitColorEncoding(snap.doc, task.nodeId)) ids.add(task.id)
    }
    return ids
  }, [snap.doc, plan])
  const encodingForRun: 'srgb' | 'display-p3' | '' = !snap.doc.colorManagement ? '' : encoding || (needsChoice.size ? '' : 'srgb')
  const waitingForEncoding = [...checked].some(id => needsChoice.has(id)) && encodingForRun === ''
  const visible = plan.tasks.filter(task => {
    if (formatFilter !== 'all' && task.format !== formatFilter) return false
    if (scaleFilter !== 'all' && String(task.scale) !== scaleFilter) return false
    const needle = query.trim().toLocaleLowerCase('en-US')
    if (!needle) return true
    return `${task.nodeName}\n${task.pageName}\n${task.path}\n${task.suffix}\n${task.format}`.toLocaleLowerCase('en-US').includes(needle)
  })
  const groups: { nodeId: string; nodeName: string; pageName: string; hidden: boolean; tasks: AllAssetTask[] }[] = []
  for (const task of visible) {
    const last = groups.at(-1)
    if (last && last.nodeId === task.nodeId && last.pageName === task.pageName) last.tasks.push(task)
    else groups.push({ nodeId: task.nodeId, nodeName: task.nodeName, pageName: task.pageName, hidden: task.hidden, tasks: [task] })
  }
  const formats = [...new Set(plan.tasks.map(task => task.format))]
  const scales = [...new Set(plan.tasks.map(task => task.scale))].sort((a, b) => a - b)
  const layerInputs = useRef(new Map<string, HTMLInputElement>())
  const request = useRef<AbortController | null>(null)
  const [links, setLinks] = useState<{ zip: string; files: ReadonlyMap<string, string> }>({ zip: '', files: new Map() })
  useEffect(() => {
    for (const group of groups) {
      const input = layerInputs.current.get(`${group.pageName}:${group.nodeId}`)
      if (!input) continue
      const selected = group.tasks.filter(task => checked.has(task.id)).length
      input.indeterminate = selected > 0 && selected < group.tasks.length
    }
  })
  useEffect(() => () => { request.current?.abort() }, [])
  useEffect(() => {
    if (!run?.counts.delivered) {
      setLinks({ zip: '', files: new Map() })
      return
    }
    const created: string[] = []
    const files = new Map<string, string>()
    for (const item of run.items) {
      if (item.status !== 'delivered' || !item.bytes) continue
      const url = URL.createObjectURL(bytesBlob(item.bytes))
      created.push(url)
      files.set(item.task.id, url)
    }
    const zip = URL.createObjectURL(bytesBlob(allAssetsZip(run), 'application/zip'))
    created.push(zip)
    setLinks({ zip, files })
    return () => { for (const url of created) URL.revokeObjectURL(url) }
  }, [run])
  function toggleIds(tasks: readonly AllAssetTask[], on: boolean) {
    setChecked(previous => {
      const next = new Set(previous)
      for (const task of tasks) {
        if (on) next.add(task.id)
        else next.delete(task.id)
      }
      return next
    })
  }
  function present(message: string | undefined): string {
    if (!message) return ''
    if (!english) return message
    return messageEnglish[message] ?? message
  }
  async function execute(ids: ReadonlySet<string>, previous: AllAssetRun | null) {
    if (busy || !ids.size || !commitExportEdits(editor)) return
    const current = editor.snapshot()
    const document = structuredClone(current.doc)
    const fresh = planAllAssets(document, { scope, pageId: current.page, revision: current.version })
    const session = editor.sessionGeneration
    const controller = new AbortController()
    request.current = controller
    const stop = editor.subscribe(() => {
      const now = editor.snapshot()
      if (now.doc.id !== current.doc.id || now.version !== current.version || now.page !== current.page || editor.sessionGeneration !== session) controller.abort()
    })
    setBusy(true)
    setProgress(text('正在按预设导出…', 'Exporting presets…'))
    const total = fresh.tasks.filter(task => ids.has(task.id)).length
    let seen = 0
    try {
      const next = await runAllAssets({
        document,
        plan: fresh,
        selectedIds: ids,
        encoding: encodingForRun,
        signal: controller.signal,
        encode,
        onItem: () => {
          seen += 1
          setProgress(text(`正在导出 ${seen}/${total}…`, `Exporting ${seen}/${total}…`))
        },
      })
      if (request.current !== controller) return
      setRun(previous ? mergeAllAssetRuns(previous, next) : next)
      setProgress('')
    } finally {
      stop()
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }
  const retryIds = new Set((run?.items ?? []).filter(item => item.status === 'failed' || item.status === 'cancelled').map(item => item.task.id))
  return <div className="all-assets-export" role="group" aria-label={text('全部资产', 'All assets')}>
    <p>{text('按各层已有预设分别列出任务。整页、合并选区和自定义区域仍可用，不会把多个图层画成一张图。', 'Lists one task for each layer preset. Page, merged selection, and custom region stay available, and layers are not flattened into one image.')}</p>
    <fieldset disabled={busy}>
      <legend>{text('范围', 'Scope')}</legend>
      <label><input type="radio" name="all-assets-scope" checked={scope === 'page'} onChange={() => { setScope('page'); setRun(null) }} />{text('当前页面', 'Current page')}</label>
      <label><input type="radio" name="all-assets-scope" checked={scope === 'document'} onChange={() => { setScope('document'); setRun(null) }} />{text('整个文档', 'Entire document')}</label>
    </fieldset>
    <div className="all-assets-filters">
      <label>{text('图层', 'Layer')}<input aria-label={text('搜索全部资产', 'Search all assets')} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      <label>{text('格式', 'Format')}<select aria-label={text('按格式筛选资产', 'Filter assets by format')} value={formatFilter} disabled={busy} onChange={event => setFormatFilter(event.target.value)}>
        <option value="all">{text('全部格式', 'All formats')}</option>
        {formats.map(format => <option key={format} value={format}>{formatLabel(format, english)}</option>)}
      </select></label>
      <label>{text('倍率', 'Scale')}<select aria-label={text('按倍率筛选资产', 'Filter assets by scale')} value={scaleFilter} disabled={busy} onChange={event => setScaleFilter(event.target.value)}>
        <option value="all">{text('全部倍率', 'All scales')}</option>
        {scales.map(scale => <option key={scale} value={String(scale)}>{scale}x</option>)}
      </select></label>
    </div>
    <div className="feature-row">
      <button type="button" disabled={busy || !visible.length} onClick={() => toggleIds(visible, true)}>{text('勾选所列', 'Select listed')}</button>
      <button type="button" disabled={busy || !visible.length} onClick={() => toggleIds(visible, false)}>{text('取消所列', 'Clear listed')}</button>
      <span>{text(`已选 ${checked.size} / ${plan.tasks.length} 项预设`, `${checked.size} of ${plan.tasks.length} presets selected`)}</span>
    </div>
    {plan.tasks.length === 0 && <p>{text('这个范围里还没有图层预设。可改为整个文档，或在右侧导出里为图层添加预设。', 'This scope has no layer presets. Switch to the whole document, or add presets in the inspector.')}</p>}
    <div className="all-assets-list">
      {groups.map(group => {
        const selected = group.tasks.filter(task => checked.has(task.id)).length
        const key = `${group.pageName}:${group.nodeId}`
        return <section className="all-assets-layer" key={key}>
          <label>
            <input
              ref={node => { if (node) layerInputs.current.set(key, node); else layerInputs.current.delete(key) }}
              type="checkbox"
              aria-label={text(`选择 ${group.nodeName} 的预设`, `Select presets for ${group.nodeName}`)}
              checked={selected === group.tasks.length && group.tasks.length > 0}
              disabled={busy}
              onChange={event => toggleIds(group.tasks, event.target.checked)}
            />
            <strong>{group.nodeName}</strong>
            {scope === 'document' && <span>{group.pageName}</span>}
            {group.hidden && <span>{text('隐藏', 'Hidden')}</span>}
          </label>
          {group.tasks.map(task => <label className="all-assets-task" key={task.id}>
            <input
              type="checkbox"
              aria-label={text(`${task.nodeName} ${formatLabel(task.format, false)} ${task.scale}x ${task.suffix || '无后缀'}`, `${task.nodeName} ${formatLabel(task.format, true)} ${task.scale}x ${task.suffix || 'no suffix'}`)}
              checked={checked.has(task.id)}
              disabled={busy}
              onChange={event => toggleIds([task], event.target.checked)}
            />
            <span>{formatLabel(task.format, english)} · {task.scale}x · {task.suffix || text('无后缀', 'no suffix')} · {task.path}{task.blockReason ? ` · ${present(task.blockReason)}` : ''}</span>
          </label>)}
        </section>
      })}
    </div>
    {!!snap.doc.colorManagement && <label>{text('输出编码', 'Output encoding')} <select aria-label={text('全部资产输出编码', 'All assets output encoding')} value={encodingForRun} disabled={busy} onChange={event => setEncoding(event.target.value as 'srgb' | 'display-p3' | '')}>
      {needsChoice.size > 0 && <option value="">{text('请选择', 'Choose')}</option>}
      <option value="srgb">sRGB</option>
      <option value="display-p3">Display P3</option>
    </select></label>}
    {waitingForEncoding && <p className="muted">{text('有图层含广色域、HDR 或负值分量。请先选择与顶部导出相同的输出编码。', 'Some layers contain wide-gamut, HDR, or negative channels. Choose the same output encoding as the top export first.')}</p>}
    <p className="muted">{text('交付为逐项下载，或一个包含文件与清单的 ZIP。清单会写明每一项的目标、修订、格式、倍率和结果。', 'Delivery is one download per file, or a ZIP with the files and a manifest. The manifest records each target, revision, format, scale, and result.')}</p>
    <div className="feature-row">
      <button type="button" disabled={busy || !checked.size || waitingForEncoding} onClick={() => void execute(checked, null)}>{busy ? text('导出中…', 'Exporting…') : text('导出所选预设', 'Export selected presets')}</button>
      {busy && <button type="button" onClick={() => { request.current?.abort(); setProgress(text('已取消导出', 'Export cancelled')) }}>{text('取消导出', 'Cancel export')}</button>}
      {!!retryIds.size && !busy && <button type="button" onClick={() => void execute(retryIds, run)}>{text('重试失败和已取消项', 'Retry failed and cancelled')}</button>}
    </div>
    <p role="status" aria-live="polite">{progress || (run ? allAssetsStatusText(run, english) : '')}</p>
    {!!run?.items.length && <ul className="all-assets-results">
      {run.items.map(item => <li key={item.task.id} data-status={item.status}>
        <span>{item.task.path} · {item.status}{item.message ? ` · ${present(item.message)}` : ''}</span>
        {item.status === 'delivered' && links.files.get(item.task.id) && <a href={links.files.get(item.task.id)} download={item.task.path}>{text('下载', 'Download')} {item.task.path}</a>}
      </li>)}
    </ul>}
    {links.zip && run && <p><a href={links.zip} download={`${filenameBase(snap.doc.name)}.zip`} onClick={event => {
      event.preventDefault()
      download(`${filenameBase(snap.doc.name)}-assets.zip`, bytesBlob(allAssetsZip(run), 'application/zip'))
    }}>{text(`下载 ZIP（${run.counts.delivered} 个文件和清单）`, `Download ZIP (${run.counts.delivered} files and manifest)`)}</a></p>}
  </div>
}

function filenameBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'assets'
}
