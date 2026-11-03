import type {DesignNode,Paint} from './model'
const derived=new WeakMap<DesignNode,DesignNode>()
/** SVG view adapter for the Rust-authored outline-mask contract. */
export function outlineMaskForRendering(node:DesignNode,inherited=false):DesignNode {
 const shape=node.mask && node.maskType==='shape'
 if(!shape&&!inherited&&(!node.mask||node.maskType!=='outline'))return node
 const cached=derived.get(node);if(cached)return cached
 const white:Paint={id:'outline',kind:'solid',color:'#ffffff',opacity:1,visible:true,blend:'normal',angle:0,stops:[],fit:'cover'}
 const result:DesignNode={...node,fills:shape||node.fills.some(p=>p.visible&&p.opacity>0)?[white]:[],
  strokes:shape?[]:node.strokes.map(s=>({...s,visible:s.visible&&s.paint.visible&&s.paint.opacity>0,paint:white})),
  effects:[],opacity:shape||node.opacity>0?1:0,blend:'normal',textRuns:node.textRuns?.map(r=>({...r,color:undefined}))}
 derived.set(node,result);return result
}
