import { desktopPet } from './desktop-pet'
import { layerExportColorOutput, pdfVectorIssues, sliceExportTarget, subtreeNeedsExplicitColorEncoding } from './export-metadata'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from './engine'
import { exportSuffixHasForbiddenCharacters, uid, type DesignNode, type ExportSetting } from './model'
import { NumberField } from './fields'
import { DraftInput } from './DraftInput'
import { commitExportEdits, ExportOwner } from './export-ownership'
import { commitPendingEdits } from './pending-edits'

type Preview = { name: string; url: string; pdf: boolean; pdfVector: boolean }
export function NodeExportPanel({editor,node}:{editor:Editor;node:DesignNode}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[previews,setPreviews]=useState<Preview[]>([])
  const managed=!!editor.state.doc.colorManagement
  const explicit=managed && subtreeNeedsExplicitColorEncoding(editor.state.doc, node.id)
  const [encoding,setEncoding]=useState<'srgb' | 'display-p3' | ''>('')
  const selected=encoding==='srgb'||encoding==='display-p3'?encoding:(explicit?'':'srgb')
  const owner=useRef(new ExportOwner()),urls=useRef<string[]>([]),mounted=useRef(true)
  // A vector preset is only offered when the node's own subtree stays inside
  // the true-vector writer's v1 scope; otherwise the bitmap PDF remains.
  const hasSettings = !!node.exportSettings?.length
  const vectorIssues=useMemo(
    ()=>hasSettings ? pdfVectorIssues(editor.state.doc,editor.state.page,{kind:'selection',nodeIds:[node.id]}) : [],
    [editor.state.doc,editor.state.page,node.id,hasSettings])
  const release=()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current=[]}
  useEffect(()=>{mounted.current=true;const manager=owner.current;manager.activate(editor);return()=>{mounted.current=false;manager.dispose();release()}},[editor,node.id])
  useEffect(()=>{setEncoding(explicit?'':'srgb')},[node.id,explicit])
  useEffect(()=>{release();setPreviews([])},[node,editor.state.doc,editor.state.page])
  const update=(fn:(settings:ExportSetting[])=>void)=>editor.updateProperties([node.id],n=>{n.exportSettings??=[];fn(n.exportSettings)},'修改图层导出设置')
  async function generate() {
    if(busy || !commitExportEdits(editor))return
    const request=owner.current.begin(editor,'layer-export');if(!request)return
    const target=node.kind==='slice' ? sliceExportTarget(request.document,node.id) : {kind:'selection' as const,nodeIds:[node.id]}
    const settings=request.document.nodes[node.id].exportSettings || []
    if(!settings.length){owner.current.cancel(request);return}
    setBusy(true);setMessage('正在生成导出预览…');release();setPreviews([])
    try {
      // Ordinary sRGB uses the same explicit clip encoding as the top bar.
      // Wide-gamut, HDR and negative channels stay blocked until that choice
      // is made; the working space is not an implicit uint16 conversion.
      const colorOutput=layerExportColorOutput(request.document,node.id,selected)
      if(settings.some(s=>['tiff','eps'].includes(s.format)||s.scale===0))throw new Error('包含仅用于 Sketch 往返的格式或零倍率设置；请改用可执行格式和正倍率')
      const {exportImage,targetBounds,filename}=await import('./export')
      const bounds=targetBounds(request.document,request.page,target)
      const pixels=settings.filter(s=>s.format!=='svg'&&s.format!=='pdf-vector').reduce((n,s)=>n+Math.ceil(bounds.width*s.scale)*Math.ceil(bounds.height*s.scale),0)
      if(pixels>64_000_000)throw new Error('批量导出总尺寸超过 6400 万像素，请拆分设置')
      const next:Preview[]=[]
      for(const setting of settings) {
        const format=(setting.format==='jpg'?'jpeg':setting.format) as 'png'|'svg'|'jpeg'|'webp'|'pdf'|'pdf-vector'
        const asset=await exportImage(request.document,request.page,format,setting.scale,colorOutput,request.signal,target)
        if(!request.isCurrent())throw new Error('导出已取消：图层或文档已变化')
        const url=URL.createObjectURL(asset.blob);urls.current.push(url)
        const name=filename(request.document.nodes[node.id].name+(setting.suffix || (setting.scale===1?'':`@${setting.scale}x`)))+'.'+(setting.format==='jpeg'?'jpg':setting.format==='pdf-vector'?'pdf':setting.format)
        if(next.some(p=>p.name===name))throw new Error('导出设置生成了同名文件，请填写不同后缀')
        next.push({name,url,pdf:setting.format==='pdf'||setting.format==='pdf-vector',pdfVector:setting.format==='pdf-vector'&&!asset.fallback})
      }
      if(request.isCurrent()){desktopPet.event('export');setPreviews(next);setMessage(`已生成 ${next.length} 个文件`)}
    } catch(error){if(request.isCurrent())desktopPet.event('error');release();if(mounted.current)setMessage(request.signal.aborted?'导出已取消：图层或文档已变化':String(error))}
    finally{owner.current.cancel(request);if(mounted.current)setBusy(false)}
  }
  return <section aria-label="图层导出设置" className="node-export-panel">
    <div className="section-title"><h3>导出</h3><button type="button" aria-label="添加图层导出设置" disabled={busy || (node.exportSettings?.length||0)>=16} onClick={()=>{if(commitPendingEdits(editor))update(s=>s.push({id:uid(),format:'png',scale:1,suffix:''}))}}>＋</button></div>
    {(node.exportSettings||[]).map((setting,i)=><div className="node-export-setting" key={setting.id}>
      <NumberField label={`导出倍率 ${i+1}`} value={setting.scale} min={.001} max={128} onChange={value=>update(s=>{const item=s.find(s=>s.id===setting.id);if(item)item.scale=value})} />
      <select aria-label={`导出格式 ${i+1}`} value={setting.format} onChange={event=>update(s=>{const item=s.find(s=>s.id===setting.id);if(item)item.format=event.target.value as ExportSetting['format']})}><option value="png">PNG</option><option value="svg">SVG</option><option value="jpeg">JPEG</option><option value="jpg">JPG（Sketch）</option><option value="webp">WebP</option><option value="pdf">PDF</option><option value="pdf-vector" disabled={vectorIssues.length>0}>PDF（矢量）</option><option value="tiff">TIFF（仅 Sketch 往返）</option><option value="eps">EPS（仅 Sketch 往返）</option></select>
      <DraftInput aria-label={`导出后缀 ${i+1}`} placeholder="后缀" value={setting.suffix} validate={v=>v.length<=80&&!exportSuffixHasForbiddenCharacters(v)} onCommit={value=>update(s=>{const item=s.find(s=>s.id===setting.id);if(item)item.suffix=value})}/>
      <button type="button" aria-label={`删除导出设置 ${i+1}`} onClick={()=>{if(commitPendingEdits(editor))update(s=>s.splice(s.findIndex(s=>s.id===setting.id),1))}}>−</button>
    </div>)}
    {managed && <label className="node-export-encoding">输出编码 <select aria-label="图层导出输出编码" value={selected} disabled={busy} onChange={event=>setEncoding(event.target.value as 'srgb' | 'display-p3' | '')}>{explicit && <option value="">请选择</option>}<option value="srgb">sRGB</option><option value="display-p3">Display P3</option></select></label>}
    {explicit && !selected && <p className="muted">此图层含广色域、HDR 或负值分量。请先选择与顶部导出相同的输出编码；未选择时不会导出，也不会把高光静默压成 8 位。</p>}
    {managed && !explicit && <p className="muted">输出编码为 sRGB，与顶部导出的 sRGB 使用同一显式编码。</p>}
    {!!node.exportSettings?.length && <button type="button" className="wide-button" disabled={busy || (explicit && !selected)} onClick={()=>void generate()}>{busy?'生成中…':'预览并导出此图层'}</button>}
    {node.exportSettings?.some(s=>s.format==='jpeg')&&<p className="muted">JPEG 使用质量 100，透明区域填充为白色。</p>}
    {node.exportSettings?.some(s=>s.format==='webp')&&<p className="muted">WebP 使用无损编码。</p>}
    {node.exportSettings?.some(s=>s.format==='pdf-vector')&&<p className="muted">矢量 PDF 把路径、渐变与文字轮廓写为原生 PDF 对象，与倍率无关{vectorIssues.length?`；当前图层包含${vectorIssues.join('、')}，将回退为位图 PDF`:''}。</p>}
    {message&&<p role="status">{message}</p>}
    {previews.map((p,i)=><div key={p.url} className="node-export-preview">{p.pdf?<span>{p.pdfVector?'PDF · 矢量':'PDF · 精确位图'}</span>:<img src={p.url} alt={`图层导出预览 ${i+1}`}/>}<a href={p.url} download={p.name}>{p.name}</a></div>)}
  </section>
}
