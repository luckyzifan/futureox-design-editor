import { useEffect, useState, type CSSProperties } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react'
import { importWarningText } from './ImportNotice'
import type { SourceWorkspace } from './LargeDocumentWorkspace'
import { focusSmallerSourceEntry, sourceErrorKind, sourceErrorSummary } from './source-error-text'
import { useProfessionalDialogText } from './professional-dialog-messages'
export { sourceErrorSummary }

/** Compact status uses the existing workbench tokens; native details stay available. */
export function SourceDocumentStatus({source}:{source:SourceWorkspace}) {
  const { tr } = useProfessionalDialogText()
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
  const kind=source.error?sourceErrorKind(source.error):undefined
  const title=tr(source.error
    ? source.failureStage==='directory'?'目录未完成'
      : source.failureStage==='preview'?'预览未完成'
      : source.failureStage==='refine'?'完整精修未完成'
      : source.failureStage==='edit'?'编辑未完成'
      : '操作未完成'
    : source.openingPreview&&(!source.nativeCanvas||source.hideNative)?'素材预览':source.busy?'正在载入':rendering?'正在绘制':'文件已就绪')
  const stages=source.stageReport
  return <aside className="source-canvas-status" aria-label={tr('源文件状态')}>
    {showStatus&&<section className={`source-status-card${pending?' is-pending':''}`} data-error={!!source.error} data-failure-stage={source.failureStage||undefined}>
      <div className="source-status-title">{source.error?<AlertCircle size={15}/>:pending?<LoaderCircle size={15}/>:<CheckCircle2 size={15}/>}<strong>{title}</strong><button aria-label={tr('关闭状态提示')} onClick={()=>{setDismissed(identity);if(source.error)source.dismissError?.()}}><X size={14}/></button></div>
      <p role={source.error?'alert':'status'}>{source.error?tr(sourceErrorSummary(source.error)):tr(source.notice||'正在准备页面…')}</p>
      {kind==='window'&&<button type="button" className="source-window-action" onClick={()=>focusSmallerSourceEntry()}>{tr('选择较小页面、素材或子树')}</button>}
      {source.error&&stages&&<ul className="source-stage-report" aria-label={tr('阶段结果')}>{(['directory','preview','refine','edit'] as const).map(stage=><li key={stage} data-stage={stage} data-status={stages[stage].status}>{tr(stages[stage].detail)}</li>)}</ul>}
      {source.error&&<details><summary>{tr('技术详情')}</summary><pre>{source.error}</pre></details>}
      {pending&&<span className="activity-track" aria-hidden="true" data-determinate={ratio!==undefined?'':undefined} style={ratio!==undefined?{ '--activity-progress': `${Math.round(ratio*100)}%` } as CSSProperties:undefined}><i/></span>}
    </section>}
    {!source.error&&source.warnings.length>0&&<section className="source-compatibility-card" aria-label={tr('导入兼容提示')}><details><summary>{source.warnings.length} {tr('项导入兼容提示')}</summary><ul>{source.warnings.map(warning=><li key={warning}>{tr(importWarningText(warning))}</li>)}</ul></details><button aria-label={tr('关闭导入提示')} onClick={source.dismissWarnings}><X size={14}/></button></section>}
  </aside>
}
