import { useEffect, useState } from 'react'
import { modalOwnsKeyboard } from './modal-keyboard'
import { profileBars, renderProfile, type RenderProfileSample } from './kernel/render-profile'

/** Diagnostic UI only: closed = no recording, no polling, no React updates. */
export function RenderProfilePanel() {
  const [open, setOpen] = useState(false)
  const [samples, setSamples] = useState<RenderProfileSample[]>([])
  const [paused, setPaused] = useState(false)
  const [selection, setSelection] = useState<number | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'p' || modalOwnsKeyboard(e.target)) return
      e.preventDefault(); setOpen(v => !v)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    if (!open) return
    renderProfile.start(); setPaused(false); setSelection(null); setSamples([])
    const timer = setInterval(() => setSamples(renderProfile.snapshot()), 500)
    return () => { clearInterval(timer); renderProfile.pause() }
  }, [open])
  if (!open) return null
  const sample = samples[selection ?? samples.length - 1]
  const bars = sample ? profileBars(sample) : []
  const attributed = bars.reduce((sum, b) => sum + b.ms, 0)
  const extent = Math.max(attributed, sample?.total ?? 0, 0.001)
  const colors = ['#eebd64', '#f28f62', '#df7272', '#ad86c8']
  const exportTrace = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 1, units: 'ms', kind: 'stage-attribution',
      note: '阶段壁钟耗时；并行编译可与编码重叠，不等于 CPU 采样栈或屏幕光子延迟。', samples }, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'render-profile.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <aside aria-label="渲染性能火焰图" style={{position:'fixed',zIndex:1100,bottom:16,left:16,width:'min(760px, calc(100vw - 32px))',background:'#171d29',color:'#eef2f9',padding:16,borderRadius:10,boxShadow:'0 6px 30px #0005',fontSize:12}}>
    <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:10}}>
      <strong style={{flex:1}}>渲染性能 · 阶段火焰图</strong>
      <button onClick={() => { if (paused) { renderProfile.start(); setSelection(null) } else renderProfile.pause(); setPaused(!paused); setSamples(renderProfile.snapshot()) }}>{paused?'重新录制':'暂停'}</button>
      <button onClick={exportTrace} disabled={!samples.length}>导出 JSON</button>
      <button aria-label="关闭渲染性能火焰图" onClick={() => setOpen(false)}>关闭</button>
    </div>
    <p>⌘ / Ctrl ⇧ P · 最多保留 512 次结果。横宽表示阶段耗时，子层包含在父层内；不是调用栈采样或时间轴。</p>
    <select aria-label="渲染样本" value={selection ?? ''} onChange={e=>setSelection(e.target.value===''?null:Number(e.target.value))} style={{width:'100%',marginBottom:10}}>
      <option value="">跟随最新结果</option>
      {samples.map((s,i)=><option key={`${s.at}-${i}`} value={i}>{i+1} · {s.kind} · {s.total.toFixed(1)} ms</option>)}
    </select>
    {sample ? <>
      <div>本次 {sample.kind}：{sample.total.toFixed(2)} ms · {sample.drawCalls ?? '—'} 次绘制 · {sample.passPixels?.toLocaleString() ?? '—'} pass 像素</div>
      {(sample.fieldUploadBytes!==undefined||sample.geometryUploadBytes!==undefined)&&<div>
        参数上传 {sample.fieldUploadBytes===undefined?'—':`${(sample.fieldUploadBytes/1048576).toFixed(2)} MiB`} ·
        几何上传 {sample.geometryUploadBytes===undefined?'—':`${(sample.geometryUploadBytes/1048576).toFixed(2)} MiB`}
      </div>}
      <div style={{display:'flex',height:32,marginTop:8}}>{bars.map((bar,i)=><div key={bar.name} title={`${bar.name}: ${bar.ms.toFixed(2)} ms`} style={{width:`${bar.ms/extent*100}%`,background:colors[i],color:'#17202b',overflow:'hidden',whiteSpace:'nowrap',padding:'7px 0',boxSizing:'border-box',borderRight:'1px solid #171d29'}}>{bar.name} {bar.ms.toFixed(1)}</div>)}</div>
      <div style={{display:'flex',height:30}}>{bars.map(bar=><div key={bar.name} style={{display:'flex',width:`${bar.ms/extent*100}%`}}>{bar.children?.map((child,i)=><div key={child.name} title={`${child.name}: ${child.ms.toFixed(2)} ms`} style={{width:`${child.ms/bar.ms*100}%`,background:colors[i],color:'#17202b',overflow:'hidden',whiteSpace:'nowrap',paddingTop:6,borderRight:'1px solid #171d29',boxSizing:'border-box'}}>{child.name} {child.ms.toFixed(1)}</div>)}</div>)}</div>
      <p>{attributed > sample.total + 1 ? '阶段有并行重叠或累计子任务，阶段总和不能当作响应延迟。' : `其余排队、通信与准备：${Math.max(0,sample.total-attributed).toFixed(2)} ms。`}</p>
    </> : <p>录制中。请缩放、平移或拖动对象。</p>}
  </aside>
}
