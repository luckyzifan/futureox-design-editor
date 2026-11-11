import { strToU8, zipSync } from 'fflate'
import { layerExportColorOutput, sliceExportTarget, type ExportTarget } from './export-metadata'
import type { ColorOutput } from './color'
import type { DesignDocument, ExportSetting } from './model'

/** Same total-pixel ceiling as exportRasterBatch / the layer preset panel. */
export const ASSET_BATCH_PIXEL_LIMIT = 64_000_000
/** Same per-file ceiling as the desktop blob download channel. */
export const ASSET_FILE_BYTE_LIMIT = 64 * 1024 * 1024
/** Raw RGBA bytes implied by the pixel ceiling. Delivery stops instead of growing past it. */
export const ASSET_BATCH_BYTE_LIMIT = ASSET_BATCH_PIXEL_LIMIT * 4
/** Same layer count as a selection export. */
export const ASSET_TASK_LIMIT = 1000
export const ASSET_BUDGET_ERROR = '批量导出总尺寸超过 6400 万像素，请拆分批次'
export const ASSET_ROUNDTRIP_ERROR = '包含仅用于 Sketch 往返的格式或零倍率设置；请改用可执行格式和正倍率'
export const ASSET_MISMATCH_ERROR = '预设与当前文档不一致，未导出'
export const ASSET_BYTE_ERROR = '导出超过桌面端 64 MiB 的限制。'
export const ASSET_MANIFEST_NAME = 'asset-manifest.json'
export const ASSET_MANIFEST_FORMAT = 'futureox.asset-batch.v1'

export type AssetTask = {
  id: string
  nodeId: string
  nodeName: string
  settingId: string
  revision: number
  documentId: string
  pageId: string
  format: ExportSetting['format']
  scale: number
  suffix: string
  path: string
  executable: boolean
  blockReason?: string
}

export type AssetTaskStatus = 'succeeded' | 'failed' | 'cancelled'

export type AssetTaskState = {
  taskId: string
  nodeId: string
  settingId: string
  revision: number
  format: ExportSetting['format']
  scale: number
  suffix: string
  path: string
  status: AssetTaskStatus
  byteLength?: number
  width?: number
  height?: number
  error?: string
}

export type AssetManifest = {
  format: typeof ASSET_MANIFEST_FORMAT
  documentId: string
  pageId: string
  revision: number
  complete: boolean
  fileCount: number
  tasks: AssetTaskState[]
}

export type AssetFile = {
  path: string
  bytes: Uint8Array
  mime: string
  taskId: string
}

export type AssetBatchResult = {
  manifest: AssetManifest
  files: AssetFile[]
}

type AssetExporter = (
  doc: DesignDocument,
  pageId: string,
  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector',
  scale: number,
  colorOutput: ColorOutput | undefined,
  signal: AbortSignal | undefined,
  target: ExportTarget,
) => Promise<{ blob: Blob; width?: number; height?: number; fallback?: boolean }>

const RASTER = new Set<ExportSetting['format']>(['png', 'jpeg', 'jpg', 'webp', 'pdf'])

function fileStem(name: string) {
  return (
    Array.from(name, character => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 180) || 'design'
  )
}

export function assetExtension(format: ExportSetting['format']) {
  if (format === 'jpeg' || format === 'jpg') return 'jpg'
  if (format === 'pdf-vector') return 'pdf'
  return format
}

export function assetFileName(nodeName: string, setting: Pick<ExportSetting, 'format' | 'scale' | 'suffix'>) {
  const suffix = setting.suffix || (setting.scale === 1 ? '' : `@${setting.scale}x`)
  return `${fileStem(`${nodeName}${suffix}`)}.${assetExtension(setting.format)}`
}

export function assetBlockReason(setting: Pick<ExportSetting, 'format' | 'scale'>): string | undefined {
  if (setting.format === 'tiff' || setting.format === 'eps' || setting.scale === 0) return ASSET_ROUNDTRIP_ERROR
  if (!Number.isFinite(setting.scale) || setting.scale < 0.001 || setting.scale > 128) return '导出倍率必须在 0.001–128 之间'
  return undefined
}

export function pageNodeIds(doc: DesignDocument, pageId: string): string[] {
  const page = doc.pages.find(item => item.id === pageId)
  if (!page) return []
  const ids: string[] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) return
    ids.push(id)
    for (const child of node.children) visit(child)
  }
  for (const id of page.children) visit(id)
  return ids
}

export function enumerateAssetTasks(doc: DesignDocument, pageId: string, revision: number): AssetTask[] {
  const tasks: AssetTask[] = []
  for (const nodeId of pageNodeIds(doc, pageId)) {
    const node = doc.nodes[nodeId]
    for (const setting of node.exportSettings ?? []) {
      const blockReason = assetBlockReason(setting)
      tasks.push({
        id: `${nodeId}\u001f${setting.id}`,
        nodeId,
        nodeName: node.name,
        settingId: setting.id,
        revision,
        documentId: doc.id,
        pageId,
        format: setting.format,
        scale: setting.scale,
        suffix: setting.suffix,
        path: assetFileName(node.name, setting),
        executable: !blockReason,
        blockReason,
      })
    }
  }
  return tasks
}

export type AssetFilter = { layer?: string; format?: string; scale?: string }

export function filterAssetTasks(tasks: readonly AssetTask[], filter: AssetFilter = {}): AssetTask[] {
  const layer = filter.layer?.trim().toLowerCase() ?? ''
  return tasks.filter(task => {
    if (filter.format && task.format !== filter.format) return false
    if (filter.scale && String(task.scale) !== filter.scale) return false
    if (!layer) return true
    return task.nodeName.toLowerCase().includes(layer) || task.path.toLowerCase().includes(layer)
  })
}

export function collidingTaskIds(tasks: readonly AssetTask[]): Set<string> {
  const grouped = new Map<string, string[]>()
  for (const task of tasks) {
    const list = grouped.get(task.path) ?? []
    list.push(task.id)
    grouped.set(task.path, list)
  }
  const ids = new Set<string>()
  for (const list of grouped.values()) if (list.length > 1) for (const id of list) ids.add(id)
  return ids
}

export function assetTaskMatches(doc: DesignDocument, pageId: string, task: AssetTask): boolean {
  if (task.documentId !== doc.id || task.pageId !== pageId) return false
  if (!pageNodeIds(doc, pageId).includes(task.nodeId)) return false
  const node = doc.nodes[task.nodeId]
  const setting = node?.exportSettings?.find(item => item.id === task.settingId)
  if (!node || !setting) return false
  return setting.format === task.format && setting.scale === task.scale && setting.suffix === task.suffix
    && assetFileName(node.name, setting) === task.path
}

export function assetManifest(input: {
  documentId: string
  pageId: string
  revision: number
  tasks: readonly AssetTaskState[]
}): AssetManifest {
  const tasks = input.tasks.map(task => ({ ...task }))
  const fileCount = tasks.filter(task => task.status === 'succeeded').length
  const complete = tasks.length > 0 && fileCount === tasks.length && tasks.every(task => task.status === 'succeeded')
  return {
    format: ASSET_MANIFEST_FORMAT,
    documentId: input.documentId,
    pageId: input.pageId,
    revision: input.revision,
    complete,
    fileCount,
    tasks,
  }
}

export function assetBatchSummary(manifest: AssetManifest, locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (manifest.complete) {
    return locale === 'en'
      ? `Completed ${manifest.fileCount} ${manifest.fileCount === 1 ? 'file' : 'files'}.`
      : `已完成 ${manifest.fileCount} 个文件。`
  }
  const failed = manifest.tasks.filter(task => task.status === 'failed').length
  const cancelled = manifest.tasks.filter(task => task.status === 'cancelled').length
  return locale === 'en'
    ? `Not complete: ${manifest.fileCount} succeeded, ${failed} failed, ${cancelled} cancelled.`
    : `未完成：${manifest.fileCount} 个成功，${failed} 个失败，${cancelled} 个已取消。`
}

function stateFrom(task: AssetTask, status: AssetTaskStatus, error?: string): AssetTaskState {
  return {
    taskId: task.id,
    nodeId: task.nodeId,
    settingId: task.settingId,
    revision: task.revision,
    format: task.format,
    scale: task.scale,
    suffix: task.suffix,
    path: task.path,
    status,
    ...(error ? { error } : {}),
  }
}

function runnableFormat(format: ExportSetting['format']): 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector' {
  if (format === 'jpg') return 'jpeg'
  if (format === 'png' || format === 'svg' || format === 'jpeg' || format === 'webp' || format === 'pdf' || format === 'pdf-vector') return format
  throw new Error(ASSET_ROUNDTRIP_ERROR)
}

function taskTarget(doc: DesignDocument, task: AssetTask): ExportTarget {
  if (doc.nodes[task.nodeId]?.kind === 'slice') return sliceExportTarget(doc, task.nodeId)
  return { kind: 'selection', nodeIds: [task.nodeId] }
}

function cancelledError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return true
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof Error && error.name === 'AbortError' || message.includes('已取消导出') || message.includes('导出已取消')
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function rasterPixels(doc: DesignDocument, pageId: string, task: AssetTask, signal: AbortSignal) {
  const { initializePicking, kernelExportPlan, kernelLayout } = await import('./kernel/picking')
  const { targetBounds } = await import('./export')
  if (signal.aborted) throw new Error('已取消导出')
  await initializePicking()
  if (signal.aborted) throw new Error('已取消导出')
  if (!Number.isFinite(task.scale) || task.scale < 0.001 || task.scale > 128) throw new Error('导出倍率必须在 0.001–128 之间')
  const plan = kernelExportPlan(targetBounds(kernelLayout(doc), pageId, taskTarget(doc, task)), task.scale)
  return plan.width * plan.height
}

async function defaultExporter(): Promise<AssetExporter> {
  const { exportImage } = await import('./export')
  return exportImage
}

export async function runAssetBatch(options: {
  document: DesignDocument
  pageId: string
  revision: number
  tasks: readonly AssetTask[]
  encoding: 'srgb' | 'display-p3' | ''
  signal: AbortSignal
  onUpdate?: (state: AssetTaskState) => void
  exportImage?: AssetExporter
}): Promise<AssetBatchResult> {
  const document = structuredClone(options.document)
  const { pageId, revision, signal } = options
  const publish = (state: AssetTaskState) => { options.onUpdate?.(state); return state }
  const finish = (tasks: AssetTaskState[], files: AssetFile[]) => ({
    files,
    manifest: assetManifest({ documentId: document.id, pageId, revision, tasks }),
  })
  if (signal.aborted) return finish(options.tasks.map(task => publish(stateFrom(task, 'cancelled'))), [])
  if (options.tasks.length > ASSET_TASK_LIMIT) {
    return finish(options.tasks.map(task => publish(stateFrom(task, 'failed', `一次最多导出 ${ASSET_TASK_LIMIT} 个预设`))), [])
  }
  const states: AssetTaskState[] = []
  const candidates: AssetTask[] = []
  for (const task of options.tasks) {
    if (task.revision !== revision || !assetTaskMatches(document, pageId, task)) {
      states.push(publish(stateFrom(task, 'failed', ASSET_MISMATCH_ERROR)))
      continue
    }
    if (task.blockReason || !task.executable) {
      states.push(publish(stateFrom(task, 'failed', task.blockReason || ASSET_ROUNDTRIP_ERROR)))
      continue
    }
    candidates.push(task)
  }
  const collisions = collidingTaskIds(candidates)
  const runnable: AssetTask[] = []
  for (const task of candidates) {
    if (collisions.has(task.id)) states.push(publish(stateFrom(task, 'failed', `导出文件名冲突：${task.path}`)))
    else runnable.push(task)
  }
  const planned: AssetTask[] = []
  let pixels = 0
  let overBudget = false
  for (const task of runnable) {
    if (signal.aborted) {
      states.push(publish(stateFrom(task, 'cancelled')))
      continue
    }
    if (!RASTER.has(task.format)) {
      planned.push(task)
      continue
    }
    try {
      const count = await rasterPixels(document, pageId, task, signal)
      pixels += count
      if (pixels > ASSET_BATCH_PIXEL_LIMIT) overBudget = true
      planned.push(task)
    } catch (error) {
      if (cancelledError(error, signal)) states.push(publish(stateFrom(task, 'cancelled')))
      else states.push(publish(stateFrom(task, 'failed', errorText(error))))
    }
  }
  if (signal.aborted) {
    for (const task of planned) states.push(publish(stateFrom(task, 'cancelled')))
    return finish(orderStates(options.tasks, states), [])
  }
  if (overBudget) {
    for (const task of planned) states.push(publish(stateFrom(task, 'failed', ASSET_BUDGET_ERROR)))
    return finish(orderStates(options.tasks, states), [])
  }
  const exportImage = options.exportImage ?? await defaultExporter()
  const files: AssetFile[] = []
  let bytesUsed = 0
  let stopForBytes = false
  for (const task of planned) {
    if (signal.aborted || stopForBytes) {
      states.push(publish(stateFrom(task, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? undefined : ASSET_BYTE_ERROR)))
      continue
    }
    try {
      const colorOutput = layerExportColorOutput(document, task.nodeId, options.encoding)
      const asset = await exportImage(document, pageId, runnableFormat(task.format), task.scale, colorOutput, signal, taskTarget(document, task))
      if (signal.aborted) {
        states.push(publish(stateFrom(task, 'cancelled')))
        continue
      }
      const bytes = new Uint8Array(await asset.blob.arrayBuffer())
      if (!bytes.byteLength) throw new Error('导出结果为空')
      if (bytes.byteLength > ASSET_FILE_BYTE_LIMIT || bytesUsed + bytes.byteLength > ASSET_BATCH_BYTE_LIMIT) {
        stopForBytes = bytesUsed + bytes.byteLength > ASSET_BATCH_BYTE_LIMIT
        states.push(publish(stateFrom(task, 'failed', ASSET_BYTE_ERROR)))
        continue
      }
      bytesUsed += bytes.byteLength
      files.push({ path: task.path, bytes, mime: mimeFor(task.format), taskId: task.id })
      states.push(publish({
        ...stateFrom(task, 'succeeded'),
        byteLength: bytes.byteLength,
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
      }))
    } catch (error) {
      states.push(publish(stateFrom(task, cancelledError(error, signal) ? 'cancelled' : 'failed', cancelledError(error, signal) ? undefined : errorText(error))))
    }
  }
  const ordered = orderStates(options.tasks, states)
  const succeeded = new Set(ordered.filter(task => task.status === 'succeeded').map(task => task.taskId))
  return finish(ordered, files.filter(file => succeeded.has(file.taskId)))
}

function orderStates(tasks: readonly AssetTask[], states: readonly AssetTaskState[]) {
  const byId = new Map(states.map(state => [state.taskId, state]))
  return tasks.map(task => byId.get(task.id) ?? stateFrom(task, 'failed', '尚未导出'))
}

function mimeFor(format: ExportSetting['format']) {
  if (format === 'png') return 'image/png'
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'svg') return 'image/svg+xml'
  if (format === 'pdf' || format === 'pdf-vector') return 'application/pdf'
  return 'application/octet-stream'
}

export function assetBatchZip(files: readonly AssetFile[], manifest: AssetManifest): Uint8Array {
  const succeeded = manifest.tasks.filter(task => task.status === 'succeeded')
  if (manifest.format !== ASSET_MANIFEST_FORMAT) throw new Error('素材清单格式无效')
  if (manifest.fileCount !== files.length || manifest.fileCount !== succeeded.length) throw new Error('清单文件数与实际文件不一致')
  if (manifest.complete !== (manifest.tasks.length > 0 && manifest.tasks.every(task => task.status === 'succeeded'))) throw new Error('清单完成状态与任务不一致')
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) {
    const task = succeeded.find(item => item.taskId === file.taskId && item.path === file.path)
    if (!task || !file.bytes.byteLength || entries[file.path]) throw new Error('导出文件无效')
    entries[file.path] = file.bytes
  }
  if (entries[ASSET_MANIFEST_NAME]) throw new Error('导出文件名与清单冲突')
  entries[ASSET_MANIFEST_NAME] = strToU8(JSON.stringify(manifest))
  return zipSync(entries, { mtime: new Date('1980-01-01T00:00:00Z') })
}

export function mergeAssetStates(tasks: readonly AssetTask[], previous: readonly AssetTaskState[], next: readonly AssetTaskState[]) {
  const byId = new Map<string, AssetTaskState>()
  for (const state of previous) byId.set(state.taskId, state)
  for (const state of next) byId.set(state.taskId, state)
  return tasks.map(task => {
    const state = byId.get(task.id)
    if (!state || state.revision !== task.revision || state.path !== task.path || state.format !== task.format || state.scale !== task.scale || state.suffix !== task.suffix) {
      return stateFrom(task, 'failed', '尚未导出')
    }
    return state
  })
}
