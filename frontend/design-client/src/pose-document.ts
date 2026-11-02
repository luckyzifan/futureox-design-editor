import type { DesignDocument, DesignNode, Matrix } from './model'
import { produceDocumentDraft } from './document-patch'
import { freezeOwnedDocument, immutableDocument } from './immutable-document'

type PoseSource = { before:WeakRef<DesignDocument>; transforms:Readonly<Record<string,Matrix>> }
const sources = new WeakMap<DesignDocument, PoseSource>()

function copyTransform(patch: Partial<DesignNode>): Matrix | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(patch, 'transform')
  if (!descriptor || !('value' in descriptor) || Object.keys(patch).length !== 1) return
  const matrix = descriptor.value
  if (!Array.isArray(matrix) || matrix.length !== 6 || Object.getPrototypeOf(matrix) !== Array.prototype) return
  const values: number[] = []
  for (let i=0; i<6; i++) {
    const item=Object.getOwnPropertyDescriptor(matrix,String(i))
    if (!item || !('value' in item) || typeof item.value!=='number' || !Number.isFinite(item.value) || Math.abs(item.value)>1e7) return
    values.push(item.value)
  }
  if (Math.abs(values[0]*values[3]-values[1]*values[2])<1e-9) return
  return Object.freeze(values) as unknown as Matrix
}

/** The producer makes the entire transition. A list of changed IDs from a
 * caller cannot certify an unchanged subtree or authorize graph operations. */
export function producePoseDocument(before: DesignDocument, patches: Readonly<Record<string,Partial<DesignNode>>>): DesignDocument | undefined {
  const ids = Object.keys(patches)
  if (!ids.length || ids.length>4096) return
  const transforms: Record<string,Matrix> = {}
  for (const id of ids) {
    if (!Object.hasOwn(before.nodes,id)) return
    const transform=copyTransform(patches[id])
    if (!transform) return
    transforms[id]=transform
  }
  if (ids.every(id=>transforms[id].every((v,i)=>Object.is(v,before.nodes[id].transform[i])))) return before
  const previous = sources.get(before), root = previous?.before.deref()
  const combined = root ? {...previous!.transforms,...transforms} : transforms
  if (Object.keys(combined).length>4096) return
  const base = root ?? before
  const doc = produceDocumentDraft(base,draft=>{
    for (const [id,transform] of Object.entries(combined)) draft.nodes[id].transform=transform
  })
  if (immutableDocument(base) && freezeOwnedDocument(doc))
    sources.set(doc,{before:new WeakRef(base),transforms:Object.freeze(combined)})
  return doc
}

/** History must still admit these operations in the native graph. */
export function poseDocumentSource(before: DesignDocument, after: DesignDocument) {
  const receipt=sources.get(after)
  if (receipt?.before.deref()===before && immutableDocument(before) && immutableDocument(after)) return receipt.transforms
}
export function retirePoseDocument(document: DesignDocument) { sources.delete(document) }
