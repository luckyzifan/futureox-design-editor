import type {Bounds,DesignDocument,Matrix,Point} from './model'
import {allParents,scene,unionBounds,multiply,inverse,worldMatrix,translate,type SceneEntry} from './geometry'
export type SmartTrack={ids:string[];bounds:Bounds}
export type SmartSelection={ids:string[];boxes:Record<string,Bounds>;x:SmartTrack[];y:SmartTrack[];gapX:number;gapY:number}
function tracks(ids:string[],boxes:Record<string,Bounds>,axis:'x'|'y'):SmartTrack[]{
  const length=axis==='x'?'width':'height',sorted=[...ids].sort((a,b)=>boxes[a][axis]-boxes[b][axis]),groups:SmartTrack[]=[]
  let end=-Infinity
  for(const id of sorted){const b=boxes[id]
    if(b[axis]<end-0.01){const group=groups.at(-1)!;group.ids.push(id);group.bounds=unionBounds(group.ids.map(id=>boxes[id]));end=Math.min(end,b[axis]+b[length])}
    else {groups.push({ids:[id],bounds:{...b}});end=b[axis]+b[length]}
  }
  return groups
}
function gap(tracks:SmartTrack[],axis:'x'|'y'):number|null{
  if(tracks.length<2)return 0
  const length=axis==='x'?'width':'height',values=tracks.slice(1).map((t,i)=>t.bounds[axis]-tracks[i].bounds[axis]-tracks[i].bounds[length])
  return values.every(g=>g>=-0.01&&Math.abs(g-values[0])<=0.02)?values[0]:null
}
/** Geometric inference only. Never changes parentage or treats auto-layout
 * children as freely positioned objects. No retained inference in the file. */
export function smartSelection(doc:DesignDocument,page:string,ids:string[],publishedEntries?:readonly SceneEntry[]):SmartSelection|null{
  if(ids.length<2||ids.length>256)return null
  const selected = new Set(ids)
  const entries = (publishedEntries ?? scene(doc,page)).filter(entry => selected.has(entry.id))
  if (entries.length !== ids.length || entries.some(entry => {
    const node = doc.nodes[entry.id], parent = doc.nodes[entry.parent]
    return entry.locked || entry.ancestors.some(id => selected.has(id)) || node.instanceOrigin ||
      (parent?.layout && parent.layout.mode !== 'none' && !node.sizing?.absolute)
  })) return null
  const boxes=Object.fromEntries(entries.map(e=>[e.id,e.bounds])),x=tracks(ids,boxes,'x'),y=tracks(ids,boxes,'y'),gapX=gap(x,'x'),gapY=gap(y,'y')
  if(gapX===null||gapY===null||x.length*y.length!==ids.length||x.some(c=>y.some(r=>c.ids.filter(id=>r.ids.includes(id)).length!==1)))return null
  return {ids:[...ids],boxes,x,y,gapX,gapY}
}
function patchesFor(doc:DesignDocument,positions:Record<string,Point>):Record<string,{transform:Matrix}>{
  const parents=allParents(doc),out:Record<string,{transform:Matrix}>={}
  for(const [id,p] of Object.entries(positions)){
    const parent=parents.get(id),basis=parent&&doc.nodes[parent]?worldMatrix(doc,parent):[1,0,0,1,0,0] as Matrix
    out[id]={transform:multiply(inverse(basis),multiply(translate(p.x,p.y),worldMatrix(doc,id)))}
  }
  return out
}
export function smartSpacing(doc:DesignDocument,model:SmartSelection,axis:'x'|'y',value:number){
  if(!Number.isFinite(value)||Math.abs(value)>1e6)throw Error('间距数值无效')
  const delta=value-(axis==='x'?model.gapX:model.gapY),positions:Record<string,Point>={}
  model[axis].forEach((track,index)=>track.ids.forEach(id=>positions[id]=axis==='x'?{x:delta*index,y:0}:{x:0,y:delta*index}))
  return patchesFor(doc,positions)
}
export function smartReorder(doc:DesignDocument,model:SmartSelection,marked:string[],target:string,swap=false){
  const axis=model.y.length===1?'x':model.x.length===1?'y':null,positions:Record<string,Point>={}
  if(!marked.length||!model.ids.includes(target)||marked.includes(target))return patchesFor(doc,positions)
  if(axis){
    const order=model[axis].map(t=>t.ids[0]),moving=order.filter(id=>marked.includes(id)),rest=order.filter(id=>!marked.includes(id)),at=rest.indexOf(target)
    if(at<0)return {}
    if(swap&&moving.length===1){const i=order.indexOf(moving[0]),j=order.indexOf(target);[order[i],order[j]]=[order[j],order[i]]}
    else {const after=order.indexOf(moving[0])<order.indexOf(target);rest.splice(at+(after?1:0),0,...moving);order.splice(0,order.length,...rest)}
    let cursor=model[axis][0].bounds[axis];const length=axis==='x'?'width':'height',gap=axis==='x'?model.gapX:model.gapY
    for(const id of order){positions[id]=axis==='x'?{x:cursor-model.boxes[id].x,y:0}:{x:0,y:cursor-model.boxes[id].y};cursor+=model.boxes[id][length]+gap}
  }else{
    // The grid reflows as row-major slots. Command drag swaps exactly two slots.
    const order=model.y.flatMap(row=>[...row.ids].sort((a,b)=>model.boxes[a].x-model.boxes[b].x)),slots=order.map(id=>model.boxes[id]),id=marked[0],from=order.indexOf(id),to=order.indexOf(target)
    if(from<0||to<0)return {}
    if(swap)[order[from],order[to]]=[order[to],order[from]]
    else {order.splice(from,1);order.splice(to,0,id)}
    order.forEach((id,index)=>positions[id]={x:slots[index].x-model.boxes[id].x,y:slots[index].y-model.boxes[id].y})
  }
  return patchesFor(doc,positions)
}
