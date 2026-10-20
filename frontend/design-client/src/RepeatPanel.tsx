import type { Editor } from './engine'
import type { DesignNode } from './model'
import { NumberField } from './fields'
import { defaultRepeat, type RepeatTransform } from './repeat-transforms'

/** Shared Web/Electron inspector. Each committed edit is one Editor undo entry. */
export function RepeatPanel({editor,node}:{editor:Editor;node:DesignNode}) {
 const r=node.repeat
 const replace=(next?:RepeatTransform)=>editor.change('重复变换',d=>{
  const n=d.nodes[node.id];if(!n)return
  if(next){d.schemaVersion=15;n.repeat=next}else delete n.repeat
 })
 const axis=(key:'translation'|'pivot'|'scale',axis:'x'|'y',value:number)=>r&&replace({...r,[key]:{...r[key],[axis]:value}})
 return <section className="repeat-panel" aria-label="非破坏性重复变换">
  <h4>重复变换</h4>
  {!r?<button onClick={()=>replace(defaultRepeat(node))}>添加重复变换</button>:<>
   <NumberField label="总次数（包含源）" value={r.count} min={1} max={256} step={1} onChange={v=>replace({...r,count:v})}/>
   <NumberField label="每步 X 位移" value={r.translation.x} onChange={v=>axis('translation','x',v)}/>
   <NumberField label="每步 Y 位移" value={r.translation.y} onChange={v=>axis('translation','y',v)}/>
   <NumberField label="每步旋转（度）" value={r.rotation*180/Math.PI} onChange={v=>replace({...r,rotation:v*Math.PI/180})}/>
   <NumberField label="每步 X 缩放" value={r.scale.x} min={0.01} max={100} step={0.1} onChange={v=>axis('scale','x',v)}/>
   <NumberField label="每步 Y 缩放" value={r.scale.y} min={0.01} max={100} step={0.1} onChange={v=>axis('scale','y',v)}/>
   <NumberField label="枢轴 X（父坐标）" value={r.pivot.x} onChange={v=>axis('pivot','x',v)}/>
   <NumberField label="枢轴 Y（父坐标）" value={r.pivot.y} onChange={v=>axis('pivot','y',v)}/>
   <small>副本由源实时派生，选中副本会编辑源。先缩放、绕枢轴旋转，再位移；每步相对父坐标。最多 256 次，展开不超过 16384 节点 / 16 MiB。</small>
   <button onClick={()=>replace()}>移除重复（保留源）</button>
  </>}
 </section>
}
