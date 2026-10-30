import { useProfessionalDialogText } from './professional-dialog-messages'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { createPresetFrame, filterFramePresets, frameCategories, validFrameSize, type FrameCategory } from './frame-presets'
import { modalKeyDown } from './modal-keyboard'
import './frame-presets.css'

export function FramePresetPanel({editor,onClose}:{editor:Editor;onClose:()=>void}) {
  const { tr } = useProfessionalDialogText()
  const [query,setQuery] = useState(''), [category,setCategory] = useState<FrameCategory|'all'>('all')
  const [width,setWidth] = useState('390'), [height,setHeight] = useState('844'), [name,setName] = useState('自定义画板')
  const [swap,setSwap] = useState(false), [error,setError] = useState('')
  const [session] = useState(() => ({generation:editor.sessionGeneration,page:editor.state.page}))
  const dialog = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = [...document.body.children].filter(e => e !== backdrop.current).map(element => ({element,inert:element.getAttribute('inert')}))
    background.forEach(({element}) => element.setAttribute('inert',''))
    search.current?.focus()
    return () => {
      background.forEach(({element,inert}) => inert === null ? element.removeAttribute('inert') : element.setAttribute('inert',inert))
      if (previous?.isConnected && !previous.closest('[role="menu"]')) previous.focus()
      else document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus()
    }
  },[])
  function create(value:{name:string;width:number;height:number}) {
    if (session.generation !== editor.sessionGeneration || session.page !== editor.state.page) { setError('页面已变化，请关闭后重新打开'); return }
    const result = createPresetFrame(editor,swap ? {...value,width:value.height,height:value.width} : value)
    if (result.ok) onClose(); else setError(result.error || '画板未创建')
  }
  const presets = filterFramePresets(query,category)
  return createPortal(<div className="frame-preset-backdrop" ref={backdrop} onPointerDown={e => {e.stopPropagation(); if(e.target===e.currentTarget) onClose()}} onWheel={e => e.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label={tr('设备与尺寸画板')} className="frame-preset-panel" ref={dialog} onKeyDown={e => modalKeyDown(e,onClose)}>
      <header><strong>{tr('设备与尺寸画板')}</strong><button type="button" onClick={onClose}>{tr('关闭')}</button></header>
      <p>{tr('逻辑设计尺寸，不模拟设备硬件。新画板放在当前页面最右侧，不嵌入选中图层。')}</p>
      <input ref={search} aria-label={tr('搜索画板预设')} placeholder={tr('搜索名称或尺寸')} value={query} onChange={e=>setQuery(e.target.value)}/>
      <select aria-label={tr('预设分类')} value={category} onChange={e=>setCategory(e.target.value as FrameCategory|'all')}><option value="all">{tr('全部分类')}</option>{Object.entries(frameCategories).map(([id,label])=><option key={id} value={id}>{tr(label)}</option>)}</select>
      <label><input type="checkbox" checked={swap} onChange={e=>setSwap(e.target.checked)}/>{tr('交换宽高（横竖方向）')}</label>
      <div className="frame-preset-list" aria-label={tr('画板尺寸预设')}>{presets.map(p=><button type="button" key={p.id} onClick={()=>create(p)}><span>{p.name}</span><span>{swap?p.height:p.width} × {swap?p.width:p.height}</span></button>)}{!presets.length&&<p>{tr('没有匹配的预设')}</p>}</div>
      <form onSubmit={e=>{e.preventDefault();create({name,width:Number(width),height:Number(height)})}}>
        <label>{tr('名称')}<input aria-label={tr('自定义画板名称')} maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>{tr('宽')}<input aria-label={tr('自定义画板宽')} type="number" min="1" max="100000" step="1" value={width} onChange={e=>setWidth(e.target.value)}/></label>
        <label>{tr('高')}<input aria-label={tr('自定义画板高')} type="number" min="1" max="100000" step="1" value={height} onChange={e=>setHeight(e.target.value)}/></label>
        <button type="submit" disabled={!validFrameSize(Number(width),Number(height))}>{tr('创建自定义画板')}</button>
      </form>
      {error&&<p role="alert">{tr(error)}</p>}
    </section>
  </div>,document.body)
}
