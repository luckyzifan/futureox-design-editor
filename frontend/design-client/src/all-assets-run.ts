import { strToU8, zipSync } from 'fflate'
import {
  ALL_ASSETS_BUDGET_REASON,
  ALL_ASSETS_CANCEL_REASON,
  ALL_ASSETS_CONFLICT_REASON,
  ALL_ASSETS_PIXEL_BUDGET,
  type AllAssetPlan,
  type AllAssetScope,
  type AllAssetTask,
} from './all-assets-plan'
import { exportImage } from './export'
import { layerExportColorOutput, sliceExportTarget } from './export-metadata'
import type { DesignDocument } from './model'

export type AllAssetEncoded = { bytes: Uint8Array; width?: number; height?: number }
export type AllAssetEncoder = (
  task: AllAssetTask,
  document: DesignDocument,
  signal: AbortSignal,
  encoding: 'srgb' | 'display-p3' | '',
) => Promise<AllAssetEncoded>
export type AllAssetStatus = 'delivered' | 'failed' | 'cancelled' | 'conflict' | 'blocked'
export type AllAssetItem = {
  task: AllAssetTask
  status: AllAssetStatus
  message?: string
  bytes?: Uint8Array
  sha256?: string
  width?: number
  height?: number
}
export type AllAssetCounts = { selected: number; delivered: number; failed: number; cancelled: number; conflict: number; blocked: number }
export type AllAssetRun = {
  documentId: string
  revision: number
  scope: AllAssetScope
  pageId: string
  items: AllAssetItem[]
  counts: AllAssetCounts
  complete: boolean
}
export type AllAssetManifest = {
  kind: 'futureox-all-assets'
  version: 1
  documentId: string
  revision: number
  scope: AllAssetScope
  pageId: string
  complete: boolean
  counts: AllAssetCounts
  items: {
    id: string
    nodeId: string
    settingId: string
    pageId: string
    revision: number
    format: AllAssetTask['format']
    scale: number
    suffix: string
    path: string
    status: AllAssetStatus
    message?: string
    bytes?: number
    sha256?: string
    width?: number
    height?: number
  }[]
}

const idle = new AbortController().signal

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function bytesBlob(bytes: Uint8Array, type?: string): Blob {
  return new Blob([arrayBuffer(bytes)], type ? { type } : undefined)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(bytes))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One preset, one target. JPG is the existing JPEG encoder. EPS and a zero scale never reach it. */
export async function encodeAllAssetTask(task: AllAssetTask, document: DesignDocument, signal: AbortSignal, encoding: 'srgb' | 'display-p3' | ''): Promise<AllAssetEncoded> {
  if (signal.aborted) throw new Error(ALL_ASSETS_CANCEL_REASON)
  const node = document.nodes[task.nodeId]
  if (!node) throw new Error('图层不存在')
  if (task.format === 'eps' || task.scale === 0) throw new Error(task.blockReason || '该预设不能导出')
  const format = (task.format === 'jpg' ? 'jpeg' : task.format) as 'png' | 'svg' | 'jpeg' | 'webp' | 'pdf' | 'pdf-vector' | 'tiff'
  const target = node.kind === 'slice' ? sliceExportTarget(document, node.id) : { kind: 'selection' as const, nodeIds: [node.id] }
  const colorOutput = layerExportColorOutput(document, node.id, encoding)
  const asset = await exportImage(document, task.pageId, format, task.scale, colorOutput, signal, target)
  if (signal.aborted) throw new Error(ALL_ASSETS_CANCEL_REASON)
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  return { bytes, width: asset.width, height: asset.height }
}

function countsOf(items: AllAssetItem[]): AllAssetCounts {
  return {
    selected: items.length,
    delivered: items.filter(item => item.status === 'delivered').length,
    failed: items.filter(item => item.status === 'failed').length,
    cancelled: items.filter(item => item.status === 'cancelled').length,
    conflict: items.filter(item => item.status === 'conflict').length,
    blocked: items.filter(item => item.status === 'blocked').length,
  }
}

function finish(meta: Pick<AllAssetRun, 'documentId' | 'revision' | 'scope' | 'pageId'>, items: AllAssetItem[]): AllAssetRun {
  const counts = countsOf(items)
  return { ...meta, items, counts, complete: items.length > 0 && counts.delivered === items.length }
}

function cancelled(message: string, signal: AbortSignal): boolean {
  return signal.aborted || message.includes('已取消导出') || message.includes('导出已取消')
}

export async function runAllAssets(input: {
  document: DesignDocument
  plan: AllAssetPlan
  selectedIds: ReadonlySet<string>
  encoding: 'srgb' | 'display-p3' | ''
  signal?: AbortSignal
  encode?: AllAssetEncoder
  onItem?: (item: AllAssetItem) => void
}): Promise<AllAssetRun> {
  const encode = input.encode ?? encodeAllAssetTask
  const signal = input.signal ?? idle
  const selected = input.plan.tasks.filter(task => input.selectedIds.has(task.id))
  const folded = new Map<string, number>()
  for (const task of selected) {
    if (!task.executable) continue
    const key = task.path.toLocaleLowerCase('en-US')
    folded.set(key, (folded.get(key) ?? 0) + 1)
  }
  let pixels = 0
  for (const task of selected) {
    if (!task.executable || (folded.get(task.path.toLocaleLowerCase('en-US')) ?? 0) > 1) continue
    pixels += task.pixelCount
  }
  const overBudget = pixels > ALL_ASSETS_PIXEL_BUDGET
  const items: AllAssetItem[] = []
  for (const task of selected) {
    let item: AllAssetItem
    const collision = task.executable && (folded.get(task.path.toLocaleLowerCase('en-US')) ?? 0) > 1
    if (!task.executable) item = { task, status: 'blocked', message: task.blockReason || '该预设不能导出' }
    else if (collision) item = { task, status: 'conflict', message: ALL_ASSETS_CONFLICT_REASON }
    else if (overBudget) item = { task, status: 'blocked', message: ALL_ASSETS_BUDGET_REASON }
    else if (signal.aborted) item = { task, status: 'cancelled', message: ALL_ASSETS_CANCEL_REASON }
    else {
      try {
        const encoded = await encode(task, input.document, signal, input.encoding)
        if (signal.aborted) throw new Error(ALL_ASSETS_CANCEL_REASON)
        if (!encoded.bytes.byteLength) throw new Error('导出结果为空')
        item = { task, status: 'delivered', bytes: encoded.bytes, sha256: await sha256Hex(encoded.bytes), width: encoded.width, height: encoded.height }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        item = { task, status: cancelled(message, signal) ? 'cancelled' : 'failed', message }
      }
    }
    items.push(item)
    input.onItem?.(item)
  }
  return finish(input.plan, items)
}

export function mergeAllAssetRuns(previous: AllAssetRun, next: AllAssetRun): AllAssetRun {
  if (previous.documentId !== next.documentId) return next
  const replaced = new Map(next.items.map(item => [item.task.id, item]))
  const items = previous.items.map(item => replaced.get(item.task.id) ?? item)
  for (const item of next.items) if (!previous.items.some(current => current.task.id === item.task.id)) items.push(item)
  return finish({ ...next, revision: next.revision }, items)
}

export function allAssetsStatusText(run: AllAssetRun, english: boolean): string {
  if (run.complete && run.counts.delivered === 1) {
    const path = run.items[0]?.task.path ?? ''
    return english ? `Exported ${path}` : `已导出 ${path}`
  }
  if (run.complete) return english ? `Exported ${run.counts.delivered} files` : `已导出 ${run.counts.delivered} 个文件`
  const pending = run.counts.failed + run.counts.cancelled + run.counts.conflict + run.counts.blocked
  const head = english ? `Delivered ${run.counts.delivered}, not delivered ${pending}` : `已交付 ${run.counts.delivered} 个，未交付 ${pending} 个`
  const parts = [
    run.counts.failed ? (english ? `failed ${run.counts.failed}` : `失败 ${run.counts.failed}`) : '',
    run.counts.cancelled ? (english ? `cancelled ${run.counts.cancelled}` : `取消 ${run.counts.cancelled}`) : '',
    run.counts.conflict ? (english ? `name conflicts ${run.counts.conflict}` : `同名冲突 ${run.counts.conflict}`) : '',
    run.counts.blocked ? (english ? `blocked ${run.counts.blocked}` : `未导出 ${run.counts.blocked}`) : '',
  ].filter(Boolean)
  return parts.length ? `${head} (${parts.join(english ? ', ' : '，')})` : head
}

export function allAssetsManifest(run: AllAssetRun): AllAssetManifest {
  return {
    kind: 'futureox-all-assets',
    version: 1,
    documentId: run.documentId,
    revision: run.revision,
    scope: run.scope,
    pageId: run.pageId,
    complete: run.complete,
    counts: run.counts,
    items: run.items.map(item => ({
      id: item.task.id,
      nodeId: item.task.nodeId,
      settingId: item.task.settingId,
      pageId: item.task.pageId,
      revision: item.task.revision,
      format: item.task.format,
      scale: item.task.scale,
      suffix: item.task.suffix,
      path: item.task.path,
      status: item.status,
      message: item.message,
      bytes: item.bytes?.byteLength,
      sha256: item.sha256,
      width: item.width,
      height: item.height,
    })),
  }
}

function safeZipPath(path: string): boolean {
  return path.length > 0 && path.length < 240 && path !== 'manifest.json' && !path.includes('..') && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
}

/** ZIP entries are the delivered bytes plus a manifest. A partial run stays partial in `complete`. */
export function allAssetsZip(run: AllAssetRun): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const item of run.items) {
    if (item.status !== 'delivered' || !item.bytes) continue
    if (!safeZipPath(item.task.path) || files[item.task.path]) throw new Error('导出路径无效或重复，未打包')
    files[item.task.path] = item.bytes
  }
  files['manifest.json'] = strToU8(`${JSON.stringify(allAssetsManifest(run))}\n`)
  return zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') })
}
