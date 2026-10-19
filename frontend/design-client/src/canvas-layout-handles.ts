import type {AutoLayout,Bounds,DesignDocument,Point} from './model'
import {apply,boxPoints,bounds,worldMatrix} from './geometry'
export type LayoutHandle={key:string;point:Point;axis:'x'|'y';padding?:number;property?:'gap'|'lineGap';sign:number;value:number}
export function layoutHandles(doc:DesignDocument,id:string):LayoutHandle[]{
  const n=doc.nodes[id],l=n?.layout;if(!n||!l||l.mode==='none')return []
  const [t,r,b,left]=l.padding,handles:LayoutHandle[]=[
    {key:'top',point:{x:n.width/2,y:t},axis:'y',padding:0,sign:1,value:t},
    {key:'right',point:{x:n.width-r,y:n.height/2},axis:'x',padding:1,sign:-1,value:r},
    {key:'bottom',point:{x:n.width/2,y:n.height-b},axis:'y',padding:2,sign:-1,value:b},
    {key:'left',point:{x:left,y:n.height/2},axis:'x',padding:3,sign:1,value:left},
  ]
  const children=n.children.map(id=>doc.nodes[id]).filter(c=>c.visible&&!c.sizing?.absolute).map(c=>({id:c.id,bounds:bounds(boxPoints({x:0,y:0,width:c.width,height:c.height}).map(p=>apply(c.transform,p)))}))
  // Adjacent geometric neighbours cover wrapped rows and grid gutters too.
  for(const axis of ['x','y'] as const){
    const length=axis==='x'?'width':'height',cross=axis==='x'?'y':'x',crossLength=axis==='x'?'height':'width',sorted=[...children].sort((a,b)=>a.bounds[axis]-b.bounds[axis])
    for(let i=0;i<sorted.length;i++){
      const a=sorted[i].bounds,b=sorted.slice(i+1).find(c=>c.bounds[axis]>=a[axis]+a[length]-.01&&Math.min(a[cross]+a[crossLength],c.bounds[cross]+c.bounds[crossLength])>Math.max(a[cross],c.bounds[cross])+.01)?.bounds
      if(!b)continue
      const main=l.mode==='grid'?axis==='x':axis===(l.mode==='horizontal'?'x':'y')
      if(!main&&!l.wrap&&l.mode!=='grid')continue
      if(main&&['space-between','space-around','space-evenly'].includes(l.justify))continue
      const mid=(a[axis]+a[length]+b[axis])/2,across=(Math.max(a[cross],b[cross])+Math.min(a[cross]+a[crossLength],b[cross]+b[crossLength]))/2
      handles.push({key:`${axis}-${i}`,axis,point:axis==='x'?{x:mid,y:across}:{x:across,y:mid},property:main?'gap':'lineGap',sign:1,value:main?l.gap:l.lineGap})
    }
  }
  return handles
}
export function adjustLayoutHandle(layout:AutoLayout,h:LayoutHandle,delta:number,{alt,shift,ctrl}:{alt:boolean;shift:boolean;ctrl:boolean}):AutoLayout{
  let value=h.value+delta*h.sign
  if(!ctrl)value=Math.round(value/(shift&&!alt?10:1))*(shift&&!alt?10:1)
  value=Math.min(1e6,Math.max(h.padding===undefined?-1e6:0,value))
  const next={...layout,padding:[...layout.padding] as AutoLayout['padding']}
  if(h.padding!==undefined){next.padding[h.padding]=value;if(alt)next.padding[(h.padding+2)%4]=value;if(alt&&shift)next.padding=[value,value,value,value]}
  else if(h.property)next[h.property]=value
  return next
}
