import {node, type DesignDocument, type DesignNode, type Paint} from './model'
import {sketch_mask_draw_plan} from './generated/design-kernel/design_kernel'
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

type DrawChange =
  | {op:'coverage'; id:string; source:string; children:string[]; mask:boolean; visible:boolean}
  | {op:'group'|'children'; id:string; children:string[]}
  | {op:'paint'|'alpha'; id:string}
  | {op:'page'; index:number; children:string[]}

/** Apply the kernel's draw order to SVG definitions, without round-tripping
 * paths, images, fonts or authored materials through WASM. */
export function sketchMaskScene(doc: DesignDocument): DesignDocument {
  const values = Object.values(doc.nodes)
  if (!values.some(n => n.mask && (n.maskType === 'shape' || n.maskChain))) return doc
  // Selection exports retain other nodes in the table but narrow the roots.
  const reachable = new Set<string>(), pending = doc.pages.flatMap(p => p.children)
  while (pending.length) {
    const id = pending.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const child of doc.nodes[id].children) pending.push(child)
  }
  const topology = {
    schemaVersion: 16, id: doc.id, name: doc.name, pages: doc.pages.map(p => ({
      id: p.id, name: '', background:'#ffffff', children:p.children,
    })),
    nodes: Object.fromEntries(values.filter(n => reachable.has(n.id)).map(n => [n.id, {
      id:n.id, kind:n.booleanOperation ? 'vector' : 'group', width:1, height:1,
      children:n.children, booleanOperation:n.booleanOperation, visible:n.visible,
      mask:n.mask, maskType:n.maskType, maskChain:n.maskChain,
    }])),
  }
  const changes: DrawChange[] = JSON.parse(sketch_mask_draw_plan(JSON.stringify(topology)))
  const nodes = {...doc.nodes}, pages = [...doc.pages]
  for (const op of changes) {
    if (op.op === 'page') { pages[op.index] = {...pages[op.index], children:op.children}; continue }
    if (op.op === 'coverage') {
      const shape = outlineMaskForRendering({...nodes[op.source], mask:true, maskType:'shape'})
      nodes[op.id] = {...shape, id:op.id, visible:op.visible, children:op.children, mask:op.mask, maskType:undefined, maskChain:undefined}
    } else if (op.op === 'group') {
      nodes[op.id] = {...node('group', 0, 0, 100, 60), id:op.id, children:op.children, blend:'pass-through'}
    } else if (op.op === 'children') {
      nodes[op.id] = {...nodes[op.id], children:op.children}
    } else if (op.op === 'paint') {
      nodes[op.id] = {...nodes[op.id], mask:false, maskType:undefined, maskChain:undefined}
    } else {
      nodes[op.id] = {...nodes[op.id], visible:true, maskChain:undefined}
    }
  }
  return {...doc, nodes, pages}
}
