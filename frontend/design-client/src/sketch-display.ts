import type {SketchDisplaySnapshot} from '../../design-desktop/src/sketch-display-contract.mjs'
import {admitDocument} from './document-admission'
import type {DesignDocument,DesignNode} from './model'
/** Hydrate just the chosen native artboard. Resource bytes are never resized or
 * recompressed, and this detached model never becomes an editable workspace. */
export async function sketchDisplayDocument(snapshot:SketchDisplaySnapshot,root:string):Promise<DesignDocument>{
  const source=snapshot.document,roots=root?[root]:source.pages[0].children
  if(root&&!snapshot.artboards.includes(root))throw Error('未知 Sketch 画板')
  const nodes:Record<string,DesignNode>={},visit=(id:string)=>{
    const n=source.nodes[id];if(!n||nodes[id])throw Error('Sketch 渲染层级无效')
    const paint=(p:DesignNode['fills'][number])=>({...p,...(p.image?{image:snapshot.assets[p.image]}:{})})
    nodes[id]={...n,fills:n.fills.map(paint),strokes:n.strokes.map(s=>({...s,paint:paint(s.paint)}))}
    for(const child of n.children)visit(child)
  }
  roots.forEach(visit)
  return admitDocument({...source,nodes,pages:[{...source.pages[0],children:[...roots]}]})
}
