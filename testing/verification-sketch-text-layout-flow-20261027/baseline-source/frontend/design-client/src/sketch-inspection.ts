import {admitSketchDisplay,type SketchDisplaySnapshot} from '../../design-desktop/src/sketch-display-contract.mjs'
import { admitSketchPreview } from '../../design-desktop/src/sketch-preview-contract.mjs'
import { ImportOwner } from './import-ownership.ts'

export type SketchPreview = Readonly<{status:'display';snapshot:SketchDisplaySnapshot;pageName:string;pageId:string} | { status: 'ready'; frameJson: string; pageName: string; pageId: string } | { status: 'unavailable'; reason: string }>

export type SketchInspection = Readonly<{
  displayName: string
  owner: Readonly<{ kernel_id: 'sketch'; document_schema: 'sketch-native-v1'; document_id: string; session_epoch: number }>
  pageCount: number
  layerCount: number
  editable: false
  renderable: false
  preview: SketchPreview
}>

/** Admit a detached preview. Native edits and saving stay in the Sketch session. */
export function admitSketchInspection(value: unknown): SketchInspection {
  if (!value || typeof value !== 'object') throw new Error('无效 Sketch 接纳结果')
  const result = value as Record<string, unknown>
  const owner = result.owner as Record<string, unknown> | undefined
  if (!owner || owner.kernel_id !== 'sketch' || owner.document_schema !== 'sketch-native-v1' ||
      typeof owner.document_id !== 'string' || !owner.document_id || owner.document_id.length > 128 || Array.from(owner.document_id).some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127) ||
      !Number.isSafeInteger(owner.session_epoch) || (owner.session_epoch as number) < 1 ||
      typeof result.displayName !== 'string' || !result.displayName || Array.from(result.displayName).some(character => character.charCodeAt(0) === 0 || character === '\\' || character === '/') ||
      !Number.isInteger(result.pageCount) || (result.pageCount as number) < 1 || (result.pageCount as number) > 100 ||
      !Number.isInteger(result.layerCount) || (result.layerCount as number) < (result.pageCount as number) || (result.layerCount as number) > 20000 ||
      result.editable !== false || result.renderable !== false)
    throw new Error('Sketch 内核身份、版本或检查能力不匹配')
  let preview: SketchPreview = { status: 'unavailable', reason: '当前桌面后端尚未提供 Sketch 预览数据' }
  if (result.preview !== undefined) {
    const p = result.preview as Record<string, unknown>
    if(p?.status==='display'){
      const snapshot=admitSketchDisplay(p.snapshot,owner as SketchInspection['owner']);if(p.pageId!==snapshot.pageId||typeof p.pageName!=='string'||p.pageName.length>800)throw Error('Sketch display page identity mismatch');preview={status:'display',snapshot,pageId:snapshot.pageId,pageName:p.pageName}
    }else if (p?.status === 'ready' && typeof p.frameJson === 'string' && typeof p.pageName === 'string' && p.pageName.length <= 800) {
      const frame = admitSketchPreview(p.frameJson, owner as SketchInspection['owner'])
      if (p.pageId !== frame.page_id) throw new Error('Sketch 预览页面身份不匹配')
      preview = { status: 'ready', frameJson: p.frameJson, pageName: p.pageName, pageId: frame.page_id }
    } else if (p?.status === 'unavailable' && typeof p.reason === 'string' && p.reason.length <= 4096) {
      preview = { status: 'unavailable', reason: p.reason }
    } else throw new Error('无效 Sketch 预览状态')
  }
  return Object.freeze({
    displayName: result.displayName,
    owner: Object.freeze({ kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: owner.document_id, session_epoch: owner.session_epoch as number }),
    preview: Object.freeze(preview),
    pageCount: result.pageCount as number, layerCount: result.layerCount as number, editable: false, renderable: false,
  })
}

export class SketchInspectionOwner extends ImportOwner {
  async inspect(editor: Parameters<ImportOwner['begin']>[0], read: () => Promise<unknown>): Promise<SketchInspection | null | undefined> {
    const request = this.begin(editor)
    try {
      const result = await read()
      if (!request.isCurrent()) return undefined
      return result === null ? null : admitSketchInspection(result)
    } catch (error) {
      if (!request.isCurrent()) return undefined
      throw error
    }
  }
}
