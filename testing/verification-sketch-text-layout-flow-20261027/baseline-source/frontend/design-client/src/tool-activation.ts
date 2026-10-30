import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason } from './canvas-action-diagnostics'
import type {Editor,Tool} from './engine'
import type {DesignDocument} from './model'
import {desktopBridge} from './desktop'
import {commitPendingEdits} from './pending-edits'
let codeFont: {id:string;resource:NonNullable<DesignDocument['fonts']>[string]}|undefined
let loading:Promise<void>|undefined
export function codeFontResource(){if(!codeFont)throw new Error('请先载入本机等宽字体');return codeFont}
async function loadCodeFont(document:DesignDocument){
 if(codeFont)return
 const existing=Object.entries(document.fonts||{}).find(([,font])=>/Menlo|Monaco|Mono|Consolas|Courier/i.test(font.family))
 if(existing){codeFont={id:existing[0],resource:existing[1]};return}
 const fonts=desktopBridge()?.fonts
 if(!fonts)throw new Error('请先通过字体面板导入等宽字体')
 const listed=await fonts.list();if(listed.status!=='ok')throw new Error(listed.status==='cancelled'?'已取消字体载入':listed.message)
 const candidates=listed.fonts.filter(f=>/Menlo|Monaco|Mono|Consolas|Courier/i.test(f.family)).sort((a,b)=>Number(!/Menlo/i.test(a.family))-Number(!/Menlo/i.test(b.family))||Number(!/Regular|Normal|Book/i.test(a.style))-Number(!/Regular|Normal|Book/i.test(b.style)))
 if(!candidates.length)throw new Error('没有找到本机等宽字体，请在字体面板导入')
 const result=await fonts.read({id:candidates[0].id});if(result.status!=='ok')throw new Error(result.status==='cancelled'?'已取消字体读取':result.message)
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.data));const hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')
 codeFont={id:`font:code:${hash}`,resource:{family:result.font.family,data:result.data}}
}
const owners=new WeakMap<Editor,{generation:number}>()
export function cancelToolActivation(editor:Editor){const owner=owners.get(editor);if(owner){owners.delete(editor);if(owner.generation===editor.sessionGeneration)editor.set({busy:false})}}
export async function activateTool(editor:Editor,tool:Tool){
 const action=beginEditorAction(editor,CanvasAction.tool,ActionSource.unknown)
 try {
 if(owners.has(editor))cancelToolActivation(editor)
 if(!editor.settleOwnedPropertyPreview('tool')||editor.interactionActive||editor.state.busy||!commitPendingEdits(editor)){action.result(ActionOutcome.blocked,editor.state.busy?ActionReason.busy:ActionReason.wrongOwner);return}
 if(tool==='code-block'){
  const generation=editor.sessionGeneration,owner={generation};owners.set(editor,owner)
  editor.set({tool,busy:true,message:'正在载入本机等宽字体…'})
  try{await(loading??=loadCodeFont(editor.state.doc).finally(()=>{loading=undefined}));if(editor.sessionGeneration!==generation||owners.get(editor)!==owner){action.result(ActionOutcome.cancelled,ActionReason.superseded);return;}const font=codeFontResource(),existing=editor.state.doc.fonts?.[font.id];if(existing&&existing.data!==font.resource.data)throw new Error('等宽字体标识冲突');if(!existing&&Object.keys(editor.state.doc.fonts||{}).length>=32)throw new Error('文档已达到32份字体资源上限');editor.set({busy:false,message:'代码块：拖动创建'});action.result(ActionOutcome.observed)}
  catch(e){action.result(ActionOutcome.rejected,ActionReason.validation);if(editor.sessionGeneration===generation&&owners.get(editor)===owner)editor.set({tool:'select',busy:false,message:String(e)})}
  finally{if(owners.get(editor)===owner)owners.delete(editor)}
 }else editor.set({tool})
 } finally {action.finish()}
}
