import { useEffect, useState } from 'react'
import { logicActionLegend, useProfessionalDialogText } from './professional-dialog-messages'
import { validatePrototype } from './automation/interactions'
import type { DesignDocument } from './model'
import type { Interaction, PrototypeAction } from './prototype'
import type { Expr } from './prototype-logic'
const literal = ():Expr => ({kind:'literal',value:true})
function Expression({value,onChange,doc,depth=0}:{value:Expr;onChange:(e:Expr)=>void;doc:DesignDocument;depth?:number}){
  const { tr } = useProfessionalDialogText()
  if(depth>16)return <span role="alert">{tr('表达式深度超过限制')}</span>
  return <fieldset><legend>{tr('表达式')}</legend><select aria-label={tr('表达式类型')} value={value.kind} onChange={e=>onChange(e.target.value==='variable'?{kind:'variable',id:Object.keys(doc.designSystem?.variables||{})[0]||''}:e.target.value==='unary'?{kind:'unary',op:'not',arg:literal()}:e.target.value==='binary'?{kind:'binary',op:'eq',left:literal(),right:literal()}:literal())}>
    <option value="literal">{tr('常量')}</option><option value="variable">{tr('变量')}</option><option value="unary">{tr('一元运算')}</option><option value="binary">{tr('二元运算')}</option></select>
    {value.kind==='literal'&&<><select aria-label={tr('常量类型')} value={typeof value.value} onChange={e=>onChange({kind:'literal',value:e.target.value==='number'?0:e.target.value==='boolean'?true:''})}><option value="boolean">{tr('布尔')}</option><option value="number">{tr('数字')}</option><option value="string">{tr('文本')}</option></select><input aria-label={tr('常量值')} value={String(value.value)} onChange={e=>onChange({...value,value:typeof value.value==='number'?Number(e.target.value):typeof value.value==='boolean'?e.target.value==='true':e.target.value})}/></>}
    {value.kind==='variable'&&<select aria-label={tr('表达式变量')} value={value.id} onChange={e=>onChange({...value,id:e.target.value})}>{Object.entries(doc.designSystem?.variables||{}).filter(([,v])=>v.kind!=='color').map(([id,v])=><option key={id} value={id}>{v.name}</option>)}</select>}
    {value.kind==='unary'&&<><select aria-label={tr('一元运算符')} value={value.op} onChange={e=>onChange({...value,op:e.target.value as 'not'|'negate'})}><option value="not">{tr('非')}</option><option value="negate">{tr('取负')}</option></select><Expression doc={doc} depth={depth+1} value={value.arg} onChange={arg=>onChange({...value,arg})}/></>}
    {value.kind==='binary'&&<><select aria-label={tr('二元运算符')} value={value.op} onChange={e=>onChange({...value,op:e.target.value as typeof value.op})}>{['eq','ne','lt','lte','gt','gte','and','or','add','subtract','multiply','divide','concat'].map(op=><option key={op}>{op}</option>)}</select><Expression doc={doc} depth={depth+1} value={value.left} onChange={left=>onChange({...value,left})}/><Expression doc={doc} depth={depth+1} value={value.right} onChange={right=>onChange({...value,right})}/></>}
  </fieldset>
}
function Actions({actions,onChange,doc,depth=0}:{actions:PrototypeAction[];onChange:(a:PrototypeAction[])=>void;doc:DesignDocument;depth?:number}){
  const { tr, locale } = useProfessionalDialogText()
  const update=(index:number,action:PrototypeAction)=>onChange(actions.map((a,i)=>i===index?action:a))
  if(depth>16)return <span role="alert">{tr('分支深度超过限制')}</span>
  return <div>{actions.map((a,i)=><fieldset key={i}><legend>{logicActionLegend(i + 1, locale)}</legend><select aria-label={tr('逻辑动作类型')} value={a.kind} onChange={e=>update(i,e.target.value==='if'?{kind:'if',expression:literal(),thenActions:[],elseActions:[]}:e.target.value==='set-variable'?{kind:'set-variable',target:Object.keys(doc.designSystem?.variables||{})[0],expression:{kind:'literal',value:0}}:{kind:e.target.value as PrototypeAction['kind'],target:Object.keys(doc.nodes)[0]})}>{['if','set-variable','navigate','overlay','back','close-overlay','scroll-to'].map(k=><option key={k}>{k}</option>)}</select>
    {a.kind==='if'&&<><Expression doc={doc} value={a.expression!} onChange={expression=>update(i,{...a,expression})}/><h5>{tr('如果成立')}</h5><Actions doc={doc} depth={depth+1} actions={a.thenActions||[]} onChange={thenActions=>update(i,{...a,thenActions})}/><h5>{tr('否则')}</h5><Actions doc={doc} depth={depth+1} actions={a.elseActions||[]} onChange={elseActions=>update(i,{...a,elseActions})}/></>}
    {a.kind==='set-variable'&&<><select aria-label={tr('赋值变量')} value={a.target||''} onChange={e=>{const v=doc.designSystem!.variables[e.target.value];update(i,{...a,target:e.target.value,value:undefined,expression:{kind:'literal',value:v.kind==='number'?0:v.kind==='boolean'?true:''}})}}>{Object.entries(doc.designSystem?.variables||{}).filter(([,v])=>v.kind!=='color').map(([id,v])=><option key={id} value={id}>{v.name}</option>)}</select><Expression doc={doc} value={a.expression||{kind:'literal',value:a.value??0}} onChange={expression=>update(i,{...a,value:undefined,expression})}/></>}
    {['navigate','overlay','scroll-to'].includes(a.kind)&&<select aria-label={tr('逻辑目标')} value={a.target||''} onChange={e=>update(i,{...a,target:e.target.value})}>{Object.values(doc.nodes).map(n=><option key={n.id} value={n.id}>{n.name}</option>)}</select>}
    <button onClick={()=>onChange(actions.filter((_,j)=>i!==j))}>{tr('删除逻辑动作')}</button><button disabled={i===0} onClick={()=>{const next=[...actions];[next[i-1],next[i]]=[next[i],next[i-1]];onChange(next)}}>{tr('上移')}</button>
  </fieldset>)}<button disabled={actions.length>=32||depth>=16} onClick={()=>onChange([...actions,{kind:'if',expression:literal(),thenActions:[],elseActions:[]}])}>{tr('添加条件分支')}</button><button disabled={actions.length>=32} onClick={()=>onChange([...actions,{kind:'back'}])}>{tr('添加顺序动作')}</button></div>
}
export function PrototypeLogicBuilder({doc,event,onChange}:{doc:DesignDocument;event:Interaction;onChange:(a:PrototypeAction[])=>void}){
  const { tr } = useProfessionalDialogText()
  const [draft,setDraft]=useState(event.actions),[error,setError]=useState('')
  useEffect(()=>setDraft(event.actions),[event.actions])
  const apply=()=>{try { const owner=Object.entries(doc.prototype?.interactions||{}).find(([,events])=>events.includes(event))?.[0];if(!owner)throw new Error('Interaction owner missing');validatePrototype(doc,{interactions:{[owner]:[{...event,actions:draft}]}});onChange(draft);setError('') }catch(e){setError(String(e))}}
  return <details><summary>{tr('高级逻辑构建器')}</summary><p>{tr('按顺序执行；数字 ±10¹²、文本 4096 字节、深度 16、单事件 256 节点。媒体与异步动作不支持。')}</p><Actions doc={doc} actions={draft} onChange={setDraft}/><button onClick={apply}>{tr('应用逻辑')}</button><button onClick={()=>{setDraft(event.actions);setError('')}}>{tr('放弃逻辑编辑')}</button>{error&&<p role="alert">{tr(error)}</p>}</details>
}
