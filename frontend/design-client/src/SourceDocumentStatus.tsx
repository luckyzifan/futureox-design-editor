import { useEffect, useState, type CSSProperties } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react'
import { importWarningText } from './ImportNotice'
import type { SourceWorkspace } from './LargeDocumentWorkspace'

export function sourceErrorSummary(error:string):string {
  const memory=/(\d+)-byte working-memory budget/.exec(error)
  if(memory&&Number(memory[1])<64*1024**2)
    return `当前启动内存预算仅为 ${(Number(memory[1])/1024**2).toLocaleString(undefined,{maximumFractionDigits:1})} MiB，无法载入这些内容。请检查启动配置并重新打开应用。`
  if(/DOCUMENT_(RESOURCE_LIMIT|TOO_LARGE)|working.set|conversion window/i.test(error))
    return '本次处理未能分配所需内存。当前内容已保留，可释放其他应用的内存后重试。'
  if(/cancel|abort|取消/i.test(error))return '操作已取消，可以重新选择页面继续。'
  return /[\u4e00-\u9fff]/.test(error)?error:'此操作未能完成。当前内容已保留，可展开技术详情查看原因。'
}

/** Compact status uses the existing workbench tokens; native details stay available. */
export function SourceDocumentStatus({source}:{source:SourceWorkspace}) {
  const [dismissed,setDismissed]=useState('')
  const rendering=source.nativeCanvas?.status?.phase==='loading'||source.nativeCanvas?.status?.phase==='refining'
  const pending=source.busy||rendering
  const progress=source.nativeCanvas?.status
  const ratio=progress&&progress.total>0?Math.max(0,Math.min(1,progress.done/progress.total)):undefined
  const identity=`${source.error}\n${source.notice}\n${pending}`
  // A new operation can fail with exactly the message the user dismissed on
  // an earlier attempt. Its error is cleared while the native call is pending.
  useEffect(()=>{if(source.error)setDismissed('')},[source.error])

  useEffect(()=>{
    if(source.error||pending||!source.notice)return
    const timer=setTimeout(()=>setDismissed(identity),5000)
    return()=>clearTimeout(timer)
  },[identity,source.error,pending,source.notice])
  // Automatic material refinement reports in the canvas badge. Keep the
  // file operation card available for initial loading and genuine errors.
  const showStatus=identity!==dismissed&&(source.error||!source.navigatingMaterials&&(source.notice||pending))
  if(!showStatus&&!source.warnings.length)return null
  return <aside className="source-canvas-status" aria-label="源文件状态">
    {showStatus&&<section className={`source-status-card${pending?' is-pending':''}`} data-error={!!source.error}>
      <div className="source-status-title">{source.error?<AlertCircle size={15}/>:pending?<LoaderCircle size={15}/>:<CheckCircle2 size={15}/>}<strong>{source.error?'操作未完成':source.openingPreview&&(!source.nativeCanvas||source.hideNative)?'素材预览':source.busy?'正在载入':rendering?'正在绘制':'文件已就绪'}</strong><button aria-label="关闭状态提示" onClick={()=>{setDismissed(identity);if(source.error)source.dismissError?.()}}><X size={14}/></button></div>
      <p role={source.error?'alert':'status'}>{source.error?sourceErrorSummary(source.error):source.notice||'正在准备页面…'}</p>
      {source.error&&<details><summary>技术详情</summary><pre>{source.error}</pre></details>}
      {pending&&<span className="activity-track" aria-hidden="true" data-determinate={ratio!==undefined?'':undefined} style={ratio!==undefined?{ '--activity-progress': `${Math.round(ratio*100)}%` } as CSSProperties:undefined}><i/></span>}
    </section>}
    {!source.error&&source.warnings.length>0&&<section className="source-compatibility-card" aria-label="导入兼容提示"><details><summary>{source.warnings.length} 项导入兼容提示</summary><ul>{source.warnings.map(warning=><li key={warning}>{importWarningText(warning)}</li>)}</ul></details><button aria-label="关闭导入提示" onClick={source.dismissWarnings}><X size={14}/></button></section>}
  </aside>
}
