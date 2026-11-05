import type {GpuNode, Rect} from './types'

/** Missing source nodes have no painter in this projection. Cross a gap only
 * when the extra per-pixel root tests remain close to those of separate draws. */
export function denseBatch(ids:readonly string[], at:number, nodes:Readonly<Record<string,GpuNode>>,
  programs:Readonly<Record<string,number>>, limit:number, crossGaps:boolean) {
  const starts:number[]=[],first=nodes[ids[at]].rect
  let x=first.x,y=first.y,right=x+first.w,bottom=y+first.h,last=at,gap=false,joined=false
  for(let k=at;k<ids.length && k-at<96 && starts.length<32;k++){
    const n=nodes[ids[k]]
    if(!n && crossGaps){gap=true;continue}
    const pc=programs[ids[k]]
    if(!n || !Number.isSafeInteger(pc) || pc<0 || pc>=limit)break
    const r=n.rect,l=Math.min(x,r.x),t=Math.min(y,r.y),h=Math.max(right,r.x+r.w),b=Math.max(bottom,r.y+r.h)
    if(gap || joined){
      const area=(right-x)*(bottom-y),combined=(h-l)*(b-t)
      if(n.opticalPrefixNext || starts.length>=8 || combined*(starts.length+1)>2*(area*starts.length+r.w*r.h))break
      joined=true;gap=false
    }
    if(n.opticalPrefixNext)crossGaps=false
    starts.push(pc);last=k;x=l;y=t;right=h;bottom=b
  }
  const write:Rect={x,y,w:right-x,h:bottom-y}
  return {starts,write,last}
}
