import {serializeNodePacket,serializePropertyPacket,planNodePaste,planPropertyPaste,MAX_PACKET_BYTES,type PageRootPaste} from '../clipboard-core'
import type {PropertyKind} from '../property-clipboard'
import type {DesignDocument} from '../model'
import {AutomationError,type AutomationExtension} from './types'
const id={type:'string',minLength:1,maxLength:128}
const ids=(maxItems=64)=>({type:'array',items:id,minItems:1,maxItems,uniqueItems:true})
const object=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
const packet={type:'string',minLength:1,maxLength:MAX_PACKET_BYTES,description:'Explicit portable clipboard text. No URI, URL, handle or OS clipboard. The complete escaped request must fit the transport envelope.'}
const point=object({x:{type:'number',minimum:-1e7,maximum:1e7},y:{type:'number',minimum:-1e7,maximum:1e7}},['x','y'])
function replaceStage(target:DesignDocument,candidate:DesignDocument){
 if(target.id!==candidate.id)throw new AutomationError('document_mismatch','Clipboard planning cannot replace document identity')
 for(const key of Object.keys(target))if(!Object.hasOwn(candidate,key))delete (target as unknown as Record<string,unknown>)[key]
 Object.assign(target,candidate)
}
export const clipboardExtensions:AutomationExtension[]=[
 {name:'clipboard.export',mutates:false,
  description:'Export explicit selected nodes and reachable dependencies, or one whole-layer property carrier. Requires current documentId/session/expectedRevision even though read-only; rejects busy or pending input. Returns resource-only portable content through MCP. Selection exports may contain private text, embedded images and complete fonts; source read permission is not permission to publish elsewhere. No OS clipboard.',
  inputSchema:{type:'object',anyOf:[object({nodeIds:ids(),kind:{enum:['nodes']}},['nodeIds','kind']),object({nodeIds:ids(1),kind:{enum:['properties']},propertyKind:{enum:['all','fills','strokes','effects']}},['nodeIds','kind'])]},
  execute(doc,p,ctx){
   const kind=p.kind as 'nodes'|'properties',propertyKind=(p.propertyKind||'all') as PropertyKind
   const content=kind==='nodes'?serializeNodePacket(doc,p.nodeIds as string[]):serializePropertyPacket(doc,p.nodeIds as string[],propertyKind)
   const nodePacket=kind==='nodes'?JSON.parse(content):undefined
   return {format:'futureox.design-clipboard.v1',mimeType:'application/vnd.futureox.clipboard',encoding:'text',kind,...(kind==='properties'?{propertyKind}:{}),
    byteLength:new TextEncoder().encode(content).byteLength,rootCount:nodePacket?nodePacket.roots.length:1,nodeCount:nodePacket?Object.keys(nodePacket.document.nodes).length:1,
    sourceDocumentId:doc.id,session:ctx.session,revision:ctx.revision,content}
  }},
 {name:'clipboard.paste',mutates:true,
  description:'Paste explicitly supplied portable node packet into the explicit page root. inPlace preserves world placement; here currently supports proven rectangle/ellipse leaf bounds only and rejects other geometry. Maximum 64 roots. No OS clipboard, handles, URL fetch, container smart placement or source-session capability. One existing Editor transaction. Use batch.apply mutationId for idempotent retries.',
  inputSchema:{type:'object',anyOf:[object({packet,pageId:id,mode:{enum:['inPlace']}},['packet','pageId','mode']),object({packet,pageId:id,mode:{enum:['here']},position:point},['packet','pageId','mode','position'])]},
  execute(doc,p,ctx){
   const options={pageId:p.pageId,mode:p.mode,...(p.mode==='here'?{position:p.position}:{})} as PageRootPaste
   const plan=planNodePaste(doc,p.packet as string,options)
   if(plan.createdRoots.length>64)throw new AutomationError('clipboard_root_limit','Clipboard paste supports at most 64 roots')
   const createdNodeCount=Object.keys(plan.candidate.nodes).filter(id=>!Object.hasOwn(doc.nodes,id)).length
   replaceStage(doc,plan.candidate);ctx.pageId=options.pageId;ctx.selection=[...plan.createdRoots];ctx.createdIds.push(...plan.createdRoots)
   return {createdRoots:[...plan.createdRoots],createdRootCount:plan.createdRoots.length,createdNodeCount,placement:'page-root',mode:options.mode}
  }},
 {name:'clipboard.pasteProperties',mutates:true,
  description:'Apply explicit style-only property packet to 1–64 explicit whole-layer targets. Preserves text content and geometry; whole-text style intentionally clears textRuns. Current Core clipboard policy rejects locked targets/ancestors atomically. No range/caret properties or OS clipboard. One Editor transaction; use batch.apply mutationId for idempotent retries.',
  inputSchema:object({packet,targetIds:ids()},['packet','targetIds']),
  execute(doc,p){const targetIds=p.targetIds as string[],plan=planPropertyPaste(doc,p.packet as string,targetIds);replaceStage(doc,plan.candidate);return {targetCount:targetIds.length,scope:'whole-layer'}}},
]
