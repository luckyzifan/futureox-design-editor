import type {Bounds,Point} from './model'
export type Measurement={from:Point;to:Point;distance:number}
const encloses=(a:Bounds,b:Bounds)=>a.x<=b.x&&a.y<=b.y&&a.x+a.width>=b.x+b.width&&a.y+a.height>=b.y+b.height
/** Distances use geometric bounds, excluding visual stroke/effect overflow. */
export function measureBounds(a:Bounds,b:Bounds):Measurement[]{
  const line=(x:number,y:number,u:number,v:number)=>({from:{x,y},to:{x:u,y:v},distance:Math.hypot(u-x,v-y)})
  if(encloses(a,b)||encloses(b,a)){
    const outer=encloses(a,b)?a:b,inner=encloses(a,b)?b:a,cx=inner.x+inner.width/2,cy=inner.y+inner.height/2
    return [line(outer.x,cy,inner.x,cy),line(inner.x+inner.width,cy,outer.x+outer.width,cy),
      line(cx,outer.y,cx,inner.y),line(cx,inner.y+inner.height,cx,outer.y+outer.height)]
  }
  const result:Measurement[]=[],ac={x:a.x+a.width/2,y:a.y+a.height/2}
  const x0=Math.max(a.x,b.x),x1=Math.min(a.x+a.width,b.x+b.width),y0=Math.max(a.y,b.y),y1=Math.min(a.y+a.height,b.y+b.height)
  const y=y0<=y1?(y0+y1)/2:ac.y,x=x0<=x1?(x0+x1)/2:ac.x
  if(a.x+a.width<=b.x)result.push(line(a.x+a.width,y,b.x,y))
  else if(b.x+b.width<=a.x)result.push(line(b.x+b.width,y,a.x,y))
  else result.push(line(a.x,y,b.x,y))
  if(a.y+a.height<=b.y)result.push(line(x,a.y+a.height,x,b.y))
  else if(b.y+b.height<=a.y)result.push(line(x,b.y+b.height,x,a.y))
  else result.push(line(x,a.y,x,b.y))
  return result.filter(m=>m.distance>1e-9)
}
