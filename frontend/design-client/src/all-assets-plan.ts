import { filename, targetBounds } from './export'
import { sliceExportTarget } from './export-metadata'
import type { DesignDocument, DesignNode, ExportSetting } from './model'

/** Sketch lists every exportable preset from File → Export → All Assets.
 * Figma exports each layer with its own export settings instead of one merged
 * selection. This plan only reads those presets. Pixel sizes come from the
 * existing export bounds, not from an official template. */
export const ALL_ASSETS_PIXEL_BUDGET = 64_000_000
export const ALL_ASSETS_ROUND_TRIP_REASON = '包含仅用于 Sketch 往返的格式或零倍率设置；请改用可执行格式和正倍率'
export const ALL_ASSETS_HIDDEN_REASON = '请选择当前页面的 1–1000 个可见图层'
export const ALL_ASSETS_CONFLICT_REASON = '与其他所选预设的文件名冲突，未写入'
export const ALL_ASSETS_BUDGET_REASON = '批量导出总尺寸超过 6400 万像素，请拆分批次'
export const ALL_ASSETS_CANCEL_REASON = '已取消导出'

export type AllAssetScope = 'page' | 'document'
export type AllAssetTask = {
  id: string
  documentId: string
  revision: number
  pageId: string
  pageName: string
  nodeId: string
  nodeName: string
  settingId: string
  format: ExportSetting['format']
  scale: number
  suffix: string
  path: string
  hidden: boolean
  executable: boolean
  blockReason?: string
  pixelCount: number
}
export type AllAssetPlan = {
  documentId: string
  revision: number
  scope: AllAssetScope
  pageId: string
  tasks: AllAssetTask[]
}

const RASTER = new Set<ExportSetting['format']>(['png', 'jpeg', 'jpg', 'webp', 'pdf', 'tiff'])
const RUNNABLE = new Set<ExportSetting['format']>([...RASTER, 'svg', 'pdf-vector'])

/** Same stem as the single-layer preset download: authored suffix, or `@scale x` when the suffix is empty and the scale is not 1. */
export function allAssetPath(nodeName: string, setting: Pick<ExportSetting, 'format' | 'scale' | 'suffix'>): string {
  const extension = setting.format === 'jpeg' || setting.format === 'jpg' ? 'jpg' : setting.format === 'pdf-vector' ? 'pdf' : setting.format
  const suffix = setting.suffix || (setting.scale === 1 ? '' : `@${setting.scale}x`)
  return `${filename(`${nodeName}${suffix}`)}.${extension}`
}

function classify(doc: DesignDocument, pageId: string, node: DesignNode, setting: ExportSetting, hidden: boolean): Pick<AllAssetTask, 'executable' | 'blockReason' | 'pixelCount'> {
  if (hidden) return { executable: false, blockReason: ALL_ASSETS_HIDDEN_REASON, pixelCount: 0 }
  if (setting.format === 'eps' || setting.scale === 0) return { executable: false, blockReason: ALL_ASSETS_ROUND_TRIP_REASON, pixelCount: 0 }
  if (!Number.isFinite(setting.scale) || setting.scale < 0.001 || setting.scale > 128) return { executable: false, blockReason: '导出倍率必须在 0.001–128 之间', pixelCount: 0 }
  if (!RUNNABLE.has(setting.format)) return { executable: false, blockReason: `不支持的导出格式 ${setting.format}`, pixelCount: 0 }
  try {
    const target = node.kind === 'slice' ? sliceExportTarget(doc, node.id) : { kind: 'selection' as const, nodeIds: [node.id] }
    const bounds = targetBounds(doc, pageId, target)
    const pixelCount = RASTER.has(setting.format) ? Math.ceil(bounds.width * setting.scale) * Math.ceil(bounds.height * setting.scale) : 0
    if (!Number.isFinite(pixelCount) || pixelCount < 0) throw new Error('导出尺寸无效')
    return { executable: true, pixelCount }
  } catch (error) {
    return { executable: false, blockReason: error instanceof Error ? error.message : String(error), pixelCount: 0 }
  }
}

function walkPage(doc: DesignDocument, pageId: string, pageName: string, revision: number, into: AllAssetTask[]) {
  const page = doc.pages.find(item => item.id === pageId)
  if (!page) return
  const visit = (id: string, hidden: boolean) => {
    const node = doc.nodes[id]
    if (!node) return
    const nextHidden = hidden || node.visible === false
    node.exportSettings?.forEach((setting, index) => {
      const classified = classify(doc, pageId, node, setting, nextHidden)
      into.push({
        id: `${pageId}:${node.id}:${index}:${setting.id}`,
        documentId: doc.id,
        revision,
        pageId,
        pageName,
        nodeId: node.id,
        nodeName: node.name,
        settingId: setting.id,
        format: setting.format,
        scale: setting.scale,
        suffix: setting.suffix,
        path: allAssetPath(node.name, setting),
        hidden: nextHidden,
        ...classified,
      })
    })
    for (const child of node.children) visit(child, nextHidden)
  }
  for (const id of page.children) visit(id, false)
}

export function planAllAssets(doc: DesignDocument, input: { scope: AllAssetScope; pageId: string; revision: number }): AllAssetPlan {
  const tasks: AllAssetTask[] = []
  const pages = input.scope === 'document' ? doc.pages : doc.pages.filter(page => page.id === input.pageId)
  for (const page of pages) walkPage(doc, page.id, page.name, input.revision, tasks)
  return { documentId: doc.id, revision: input.revision, scope: input.scope, pageId: input.pageId, tasks }
}
