import type { DesignDocument,Matrix } from '../model'

type PoseSource={document:DesignDocument;transforms:Record<string,Matrix>}
const sources=new WeakMap<DesignDocument,PoseSource>()
/** Private producer witness. Only a transforms-only snapshot constructed here
 * may request derivation from an acknowledged authored document. */
export function interactionPatchedDocument(document:DesignDocument,patches:Record<string,{transform?:Matrix}>):DesignDocument {
  const entries=Object.entries(patches),eligible=entries.length>0&&entries.length<=16&&entries.every(([id,p])=>
    Object.hasOwn(document.nodes,id)&&Object.keys(p).every(key=>key==='transform')&&p.transform?.length===6&&p.transform.every(Number.isFinite))
  const transforms:Record<string,Matrix>={}
  const nodes={...document.nodes}
  for(const [id,patch] of entries){
    const transform=eligible?Object.freeze([...patch.transform!]) as unknown as Matrix:patch.transform
    const value={...document.nodes[id],...patch,...(transform?{transform}:{})}
    Object.defineProperty(nodes,id,{value:eligible?Object.freeze(value):value,writable:true,enumerable:true,configurable:true})
    if(eligible)Object.defineProperty(transforms,id,{value:transform,enumerable:true})
  }
  const candidate={...document,nodes}
  if(eligible){Object.freeze(nodes);Object.freeze(candidate);Object.freeze(transforms);sources.set(candidate,{document,transforms})}
  return candidate
}
export function interactionDocumentSource(document:DesignDocument){return sources.get(document)}
