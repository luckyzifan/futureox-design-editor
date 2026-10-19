import { SketchReadOnlyPreview } from './SketchReadOnlyPreview'
import { useEffect, useRef, useState } from 'react'
import { modalKeyDown } from './modal-keyboard'
import type { SketchInspection } from './sketch-inspection'

export function SketchInspectionDialog({ result, onClose }: { result: SketchInspection | null; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null)
  const [opened,setOpened]=useState<string|null>(null)
  const identity=result?`${result.owner.document_id}/${result.owner.session_epoch}`:null
  const confirmed=!!identity&&opened===identity
  const canOpen=!!result&&result.preview.status!=='unavailable'
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(()=>{if(identity&&!confirmed)confirm.current?.focus()},[identity,confirmed])
  return <div className="modal-backdrop" data-desktop-dialog="true">
    <section className={`remote-modal sketch-open-dialog ${confirmed?'is-open':'is-confirmation'}`} role="dialog" aria-modal="true" aria-labelledby="sketch-inspection-title"
      onKeyDown={event => modalKeyDown(event, onClose)}>
      <header className="sketch-open-header">
        <h2 id="sketch-inspection-title">{confirmed?result!.displayName:'打开 Sketch 文件'}</h2>
        {result&&<p>{confirmed?'':`${result.displayName} · `}{result.pageCount} 页 · {result.layerCount} 个图层（含页面）</p>}
      </header>
      <div className="sketch-open-body">
        {confirmed&&result?<SketchReadOnlyPreview result={result}/>:result?<>
          <p>确认后打开原生画板预览，可切换画板、缩放和平移。</p>
          <p>缺失字体使用项目默认字体。</p>
          {!canOpen&&<p role="alert">当前文件暂时无法预览：{result.preview.status==='unavailable'?result.preview.reason:''}</p>}
        </>:<p role="status">请选择 .sketch 文件，正在等待文件检查结果…</p>}
      </div>
      <footer className="sketch-open-footer" data-testid="sketch-open-actions">
        <span>{confirmed?'只读预览 · 原文件未修改':'本机打开 · 原文件保留'}</span>
        <button type="button" className={confirmed?'primary':undefined} ref={close} onClick={onClose}>{confirmed?'完成':'取消'}</button>
        {!confirmed&&<button type="button" className="primary" ref={confirm} disabled={!canOpen} onClick={()=>{if(canOpen)setOpened(identity)}}>确认打开</button>}
      </footer>
    </section>
  </div>
}
