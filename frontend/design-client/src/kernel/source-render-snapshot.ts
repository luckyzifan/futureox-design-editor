import type { SourceCanvasSnapshot } from '../desktop'
export type SourceRenderSnapshot = Pick<SourceCanvasSnapshot,'owner'|'revision'|'token'|'nodes'|'pageId'|'stageId'>
/** Only scalar ownership crosses the worker boundary. Layout hints, image
 * data, warnings and filesystem descriptors are never render input carriers. */
export function sourceRenderSnapshot(value: SourceRenderSnapshot): SourceRenderSnapshot {
  const id=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=128&&/^[a-zA-Z0-9-]+$/.test(value)&&value.trim()===value
  const integer=(value:unknown,minimum=0)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum
  if(!value||!id(value.token)||!id(value.owner?.documentId)||!integer(value.owner.sessionEpoch,1)||
    !integer(value.revision)||!integer(value.nodes,1)||!id(value.pageId)||!id(value.stageId))throw Error('Invalid source canvas owner')
  return Object.freeze({token:value.token,owner:Object.freeze({documentId:value.owner.documentId,sessionEpoch:value.owner.sessionEpoch}),revision:value.revision,nodes:value.nodes,pageId:value.pageId,stageId:value.stageId})
}
