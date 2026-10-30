import type { Network, Point } from './model'
import type { ShapeBuilderRegion } from './shape-builder'

type Polynomial = [number,number,number,number]
type Curve = { x: Polynomial; y: Polynomial }
const value=(p:Polynomial,t:number)=>((p[0]*t+p[1])*t+p[2])*t+p[3]
function turns(p:Polynomial):number[] {
  const a=3*p[0],b=2*p[1],c=p[2],scale=Math.max(Math.abs(a),Math.abs(b),Math.abs(c),1)
  if(Math.abs(a)<scale*1e-14)return Math.abs(b)<scale*1e-14?[]:[-c/b].filter(t=>t>0&&t<1)
  const d=b*b-4*a*c;if(d<0)return []
  const q=-.5*(b+Math.sign(b||1)*Math.sqrt(d)), roots=q===0?[-b/(2*a)]:[q/a,c/q]
  return [...new Set(roots.filter(t=>t>0&&t<1))].sort((a,b)=>a-b)
}
/** Isolate cubic roots by derivative-monotone intervals. This changes only
 * picking, never authored geometry, and does not polygon-tessellate curves. */
function roots(p:Polynomial):number[] {
  const stops=[0,...turns(p),1],out:number[]=[],epsilon=Math.max(...p.map(Math.abs),1)*1e-12
  for(const t of stops)if(Math.abs(value(p,t))<=epsilon)out.push(t)
  for(let i=1;i<stops.length;i++) {
    let lo=stops[i-1],hi=stops[i],l=value(p,lo),h=value(p,hi)
    if(l===0||h===0||(l<0)===(h<0))continue
    for(let j=0;j<48;j++){const mid=(lo+hi)/2,m=value(p,mid);if((m<0)===(l<0)){lo=mid;l=m}else{hi=mid;h=m}}
    out.push((lo+hi)/2)
  }
  return out.sort((a,b)=>a-b).filter((t,i,a)=>i===0||t-a[i-1]>1e-10)
}
const coefficients=(a:number,b:number,c:number,d:number):Polynomial=>[-a+3*b-3*c+d,3*a-6*b+3*c,-3*a+3*b,a]
const cache=new WeakMap<Network,Curve[]>()
function curves(network:Network):Curve[] {
  const cached=cache.get(network);if(cached)return cached
  const vertices=new Map(network.vertices.map(v=>[v.id,v]))
  const result=network.edges.map(e=>{
    const a=vertices.get(e.from)!,d=vertices.get(e.to)!
    if(!a||!d)throw Error('Invalid Shape Builder preview edge')
    const b=e.c1||a,c=e.c2||d
    return {x:coefficients(a.x,b.x,c.x,d.x),y:coefficients(a.y,b.y,c.y,d.y)}
  });cache.set(network,result);return result
}
function contains(cs:Curve[],p:Point,spend:()=>void):boolean {
  let crossings=0
  for(const c of cs){spend();const stops=[0,...turns(c.y),1]
    for(let i=1;i<stops.length;i++){
      let lo=stops[i-1],hi=stops[i];const y0=value(c.y,lo),y1=value(c.y,hi)
      // Half-open intervals count shared vertices once and tangencies twice.
      if(!((y0<=p.y&&y1>p.y)||(y1<=p.y&&y0>p.y)))continue
      for(let j=0;j<48;j++){const mid=(lo+hi)/2;if((value(c.y,mid)<p.y)===(y0<y1))lo=mid;else hi=mid}
      if(value(c.x,(lo+hi)/2)>p.x)crossings++
    }
  }
  return crossings%2===1
}
/** Sweeps the whole segment between delivered pointer events. Intersections
 * partition it into intervals; analytic even-odd midpoint tests retain holes.
 * A finite work budget fails atomically rather than returning partial picks. */
export function shapeBuilderSegmentRegions(regions:ShapeBuilderRegion[],a:Point,b:Point):string[] {
  if(![a.x,a.y,b.x,b.y].every(Number.isFinite))throw Error('Invalid Shape Builder pointer coordinates')
  let checks=0;const spend=()=>{if(++checks>250000)throw Error('拖动路径过于复杂，请缩短拖动距离')}
  const dx=b.x-a.x,dy=b.y-a.y,length2=dx*dx+dy*dy,selected:string[]=[]
  for(const region of regions){const cs=curves(region.network),cuts=[0,1]
    if(length2>1e-20)for(const c of cs){spend()
      const p=c.x.map((x,i)=>(x-(i===3?a.x:0))*dy-(c.y[i]-(i===3?a.y:0))*dx) as Polynomial
      for(const t of roots(p)){
        const u=((value(c.x,t)-a.x)*dx+(value(c.y,t)-a.y)*dy)/length2
        if(u>0&&u<1)cuts.push(u)
      }
      if(cuts.length>2048)throw Error('拖动交点过多，请缩短拖动距离')
    }
    cuts.sort((a,b)=>a-b)
    const points=length2<=1e-20?[a]:cuts.slice(1).map((u,i)=>{const t=(u+cuts[i])/2;return {x:a.x+dx*t,y:a.y+dy*t}})
    if(points.some(p=>contains(cs,p,spend)))selected.push(region.id)
  }
  return selected
}
