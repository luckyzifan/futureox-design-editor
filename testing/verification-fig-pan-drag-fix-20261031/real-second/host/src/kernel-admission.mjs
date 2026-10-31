import {admitSketchDisplay} from './sketch-display-contract.mjs'
import { admitSketchPreview } from './sketch-preview-contract.mjs'
import path from 'node:path'

/** File formats select adapters within the single design kernel. */
export function formatForNativePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 32 * 1024 || filePath.includes('\0') || !path.isAbsolute(filePath))
    throw new Error('Invalid native document path')
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.fd') return 'fd'
  if (extension === '.sketch') return 'sketch'
  throw new Error('Unsupported native document format')
}

/** Discard backend extras: filesystem paths and native JSON must not reach the renderer. */
export function sketchInspection(result, documentId, sessionEpoch, displayName) {
  const owner = result?.owner
  if (owner?.kernel_id !== 'sketch' || owner.document_schema !== 'sketch-native-v1' ||
      owner.document_id !== documentId || owner.session_epoch !== sessionEpoch ||
      !Number.isSafeInteger(sessionEpoch) || sessionEpoch < 1 ||
      !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 100 ||
      !Number.isInteger(result.layerCount) || result.layerCount < result.pageCount || result.layerCount > 20000 ||
      result.editable !== false || result.renderable !== false)
    throw new Error('Unsupported or stale Sketch inspection contract')
  let preview = { status: 'unavailable', reason: '当前桌面后端尚未提供 Sketch 预览数据' }
  if(result.preview?.status==='display'){
    const p=result.preview,snapshot=admitSketchDisplay(p.snapshot,owner)
    if(p.pageId!==snapshot.pageId||typeof p.pageName!=='string'||p.pageName.length>800)throw Error('Sketch display page identity mismatch')
    preview={status:'display',snapshot,pageName:p.pageName,pageId:p.pageId}
  }else if (result.preview?.status === 'ready') {
    const p = result.preview
    const frame = admitSketchPreview(p.frameJson, owner)
    if (typeof p.pageName !== 'string' || p.pageName.length > 800 || p.pageId !== frame.page_id)
      throw new Error('Sketch preview page identity mismatch')
    preview = { status: 'ready', frameJson: p.frameJson, pageName: p.pageName, pageId: p.pageId }
  } else if (result.preview !== undefined) {
    if (result.preview.status !== 'unavailable' || typeof result.preview.reason !== 'string' || result.preview.reason.length > 4096)
      throw new Error('Invalid Sketch preview status')
    preview = { status: 'unavailable', reason: result.preview.reason }
  }
  return {
    displayName,
    owner: { kernel_id: 'sketch', document_schema: 'sketch-native-v1', document_id: documentId, session_epoch: sessionEpoch },
    pageCount: result.pageCount, layerCount: result.layerCount, editable: false, renderable: false, preview,
  }
}
