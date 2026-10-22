import type { Editor } from '../engine'
import type { DesignDocument } from '../model'
export type InteractionPreviewFailure = { document:DesignDocument;epoch:number;pageId:string;sequence:number;ids:readonly string[] }
export type InteractionPreviewRecovery = {
 editor:Editor; pending:()=>Parameters<Editor['preview']>|null
 gesture:()=>{kind:string;ids:string[];duplicating?:boolean}|null
 sequence:()=>number;clearPending:()=>void;restoreRetained:()=>void;end:()=>void;restoreOverlays:()=>void
}
/** Receiver fence is authoritative: renderer props may lag the current editor.
 * The existing transaction and latest absolute patch remain the only mutation. */
export function recoverInteractionPreview(failure:InteractionPreviewFailure,context:InteractionPreviewRecovery) {
 const {editor}=context,pending=context.pending(),gesture=context.gesture()
 if(!pending||gesture?.kind!=='move'||gesture.duplicating||!editor.interactionActive||
  failure.epoch!==editor.sessionGeneration||failure.document!==editor.state.doc||failure.pageId!==editor.state.page||
  failure.sequence!==context.sequence()||failure.ids.length!==gesture.ids.length||
  failure.ids.some((id,index)=>id!==gesture.ids[index])||failure.ids.length!==editor.state.selection.length||
  failure.ids.some(id=>!editor.state.selection.includes(id)))return false
 context.clearPending();context.restoreRetained()
 const accepted=editor.preview(...pending)
 context.end();context.restoreOverlays()
 return accepted
}
