import type { DesignDocument, DesignNode, Matrix, Point } from './model'
/** Total appearances includes the source. Transform = (T(delta) T(pivot)
 * R(radians) S(scale) T(-pivot))^i × source transform, in parent coordinates. */
export type RepeatTransform = { count: number; translation: Point; pivot: Point; rotation: number; scale: Point }
export const REPEAT_MAX_NODES = 16384, REPEAT_MAX_BYTES = 16 * 1024 * 1024
const mul=(a:Matrix,b:Matrix):Matrix=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
const identity=():Matrix=>[1,0,0,1,0,0]
const finite=(v:unknown,max=1e7):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=max
const point=(v:unknown):v is Point=>!!v&&typeof v==='object'&&Object.keys(v).length===2&&finite((v as Point).x)&&finite((v as Point).y)
function checkTransform(t:Matrix) { if(t.some(v=>!finite(v,1e9))||Math.abs(t[0]*t[3]-t[1]*t[2])<1e-12)throw Error('重复变换超出精度预算') }
export function repeatStep(r:RepeatTransform):Matrix {
 const s=Math.sin(r.rotation),c=Math.cos(r.rotation),a=c*r.scale.x,b=s*r.scale.x,d=c*r.scale.y,e=-s*r.scale.y
 return [a,b,e,d,r.translation.x+r.pivot.x-a*r.pivot.x-e*r.pivot.y,r.translation.y+r.pivot.y-b*r.pivot.x-d*r.pivot.y]
}
export function validateRepeat(r:RepeatTransform) {
 if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='count,pivot,rotation,scale,translation'||!Number.isInteger(r.count)||r.count<1||r.count>256||!point(r.translation)||!point(r.pivot)||!point(r.scale)||!finite(r.rotation,Math.PI*2*100)||r.scale.x<0.01||r.scale.x>100||r.scale.y<0.01||r.scale.y>100)throw Error('重复变换参数无效：次数 1–256，正缩放 0.01–100')
 let power=identity();for(let i=1;i<r.count;i++){power=mul(repeatStep(r),power);checkTransform(power)}
}
export const hasRepeats=(d:DesignDocument)=>Object.values(d.nodes).some(n=>n.repeat!==undefined)
export function repeatDerivedId(path:string) {
 const bytes=new TextEncoder().encode(path)
 const hex=[2166136261,2166136261^0x9e3779b9,2166136261^0x85ebca6b,2166136261^0xc2b2ae35].map(seed=>{let h=seed;for(const b of bytes)h=Math.imul(h^b,16777619);return (h>>>0).toString(16).padStart(8,'0')}).join('')
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
export function validateRepeatDocument(d:DesignDocument) {
 if(!hasRepeats(d))return
 for(const n of Object.values(d.nodes).filter(n=>n.booleanOperation)){
  const pending=[...n.children],seen=new Set<string>();while(pending.length){const id=pending.pop()!;if(seen.has(id))throw Error('重复源存在循环');seen.add(id);const child=d.nodes[id];if(!child)throw Error('缺少重复源');if(child.repeat)throw Error('布尔操作内部的重复需先显式展开');pending.push(...child.children)}
 }
 let nodes=0,bytes=0;const seen=new Set<string>()
 function walk(id:string,m:number,depth:number){
  if(depth>64||seen.has(id))throw Error('重复源存在循环');seen.add(id)
  const n=d.nodes[id];if(!n)throw Error('缺少重复源');if(n.repeat){validateRepeat(n.repeat);if(n.mask||n.kind==='slice')throw Error('蒙版和切片不能拥有重复变换');let power=identity();for(let i=0;i<n.repeat.count;i++){checkTransform(mul(power,n.transform));power=mul(repeatStep(n.repeat),power)}}
  m*=n.repeat?.count??1;nodes+=m;if(nodes>REPEAT_MAX_NODES)throw Error('重复场景超过 16384 个节点')
  bytes+=(new TextEncoder().encode(JSON.stringify(n)).length+512)*m;if(bytes>REPEAT_MAX_BYTES)throw Error('重复场景超过 16 MiB')
  for(const c of n.children)walk(c,m,depth+1)
 }
 for(const p of d.pages)for(const id of p.children)walk(id,1,0)
}
const recentScenes:DesignDocument[]=[]
const cache=new WeakMap<DesignDocument,DesignDocument>(),origins=new WeakMap<DesignDocument,Map<string,string>>()
export function repeatSourceId(d:DesignDocument,id:string) {return origins.get(d)?.get(id)??id}
/** Disposable immutable scene. Never persist this result or use it as Editor state. */
export function expandRepeats(d:DesignDocument):DesignDocument {
 if(!hasRepeats(d))return d
 const cached=cache.get(d);if(cached)return cached
 validateRepeatDocument(d)
 const nodes:Record<string,DesignNode>={},sourceIds=new Map<string,string>()
 function walk(id:string,path:string):string[]{
  const source=d.nodes[id],count=source.repeat?.count??1,step=source.repeat?repeatStep(source.repeat):identity(),roots:string[]=[];let power=identity()
  for(let i=0;i<count;i++){
   const p=i===0?path:`${path}/${id}:${i}`,newId=p?repeatDerivedId(`repeat.v1${p}/${id}`):id
   if(p&&d.nodes[newId])throw Error('重复节点标识冲突')
   const transform=mul(power,source.transform);checkTransform(transform)
   const n={...source,id:newId,transform,children:source.children.flatMap(c=>walk(c,p))};delete n.repeat
   if(p){delete n.component;delete n.componentKey;delete n.componentSet;delete n.instance;delete n.instanceOrigin}
   if(nodes[newId])throw Error('重复节点标识冲突');nodes[newId]=n;sourceIds.set(newId,id);roots.push(newId);power=mul(step,power)
  }return roots
 }
 const pages=d.pages.map(p=>({...p,children:p.children.flatMap(id=>walk(id,''))})),result={...d,pages,nodes}
 cache.set(d,result);origins.set(result,sourceIds)
 // Undo history retains authored snapshots. Do not multiply the derived-scene
 // budget by every history entry: retain at most two reusable expansions.
 recentScenes.push(d);while(recentScenes.length>2)cache.delete(recentScenes.shift()!)
 return result
}
export function defaultRepeat(n:DesignNode):RepeatTransform {return {count:3,translation:{x:n.width+16,y:0},pivot:{x:n.transform[4],y:n.transform[5]},rotation:0,scale:{x:1,y:1}}}
