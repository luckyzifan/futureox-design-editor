import {sliceExportTarget} from './export'
import type { Editor } from './engine'
import { desktopBridge } from './desktop'
import { ExportOwner } from './export-ownership'
const active = new WeakMap<Editor, ExportOwner>()
export async function copySelectionAsset(editor: Editor, format: 'png'|'svg') {
  if (!editor.state.selection.length) throw new Error('请选择要复制的图层')
  if (format === 'png' && editor.state.doc.colorManagement) throw new Error('系统图像剪贴板不能保证 HDR/广色域原始颜色；请使用保留色彩配置的 PNG 导出')
  active.get(editor)?.dispose()
  const owner=new ExportOwner();active.set(editor,owner);owner.activate(editor)
  const request=owner.begin(editor,`clipboard:${format}`)!
  try {
    const {exportImage}=await import('./export')
    const asset=await exportImage(request.document,request.page,format,format==='png'?2:1,undefined,request.signal,request.selection.length===1&&request.document.nodes[request.selection[0]].kind==='slice'?sliceExportTarget(request.document,request.selection[0]):{kind:'selection',nodeIds:[...request.selection]})
    const payload=format==='svg'?{svg:await asset.blob.text(),text:await asset.blob.text()}:{image:await dataUrl(asset.blob)}
    if(!request.isCurrent()) throw new Error('复制已取消：文档或选区已变化')
    const native=desktopBridge()?.clipboard
    if(native) {
      const result=await native.write(payload)
      if(result.status!=='ok') throw new Error(result.status==='cancelled'?'复制已取消':result.message)
    } else if(format==='svg') await navigator.clipboard.writeText(payload.text!)
    else {
      if(!navigator.clipboard?.write || typeof ClipboardItem==='undefined') throw new Error('当前浏览器不支持图像剪贴板，请使用 PNG 导出')
      await navigator.clipboard.write([new ClipboardItem({'image/png':asset.blob})])
    }
    if(request.isCurrent()) editor.notify(`已复制 ${format.toUpperCase()}${format==='png'?'（2×）':''}`)
  } finally {owner.dispose();if(active.get(editor)===owner)active.delete(editor)}
}
async function dataUrl(blob: Blob) {
  if(blob.size>24*1024*1024) throw new Error('剪贴板图像超过大小限制，请使用 PNG 导出')
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary=''
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768))
  return 'data:image/png;base64,'+btoa(binary)
}
