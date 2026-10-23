import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Editor } from '../../frontend/design-client/src/engine'
import { blank } from '../../frontend/design-client/src/model'
import { initializePicking } from '../../frontend/design-client/src/kernel/picking'
import { prepareDocumentJson } from '../../frontend/design-client/src/prepared-document'
import { proveLocalEdit } from '../../frontend/design-client/src/local-edit-proof'
import { documentPatch } from '../../frontend/design-client/src/document-patch'
import { compileEditOps } from '../../frontend/design-client/src/kernel/op-sync'
import { createCpuStageDiagnostics } from '../../frontend/design-client/src/cpu-stage-diagnostics'
const output=new URL('./editor-probe.json',import.meta.url)
const plan=JSON.parse(readFileSync(new URL('./probe-plan.json',import.meta.url),'utf8'))
const raw=readFileSync(plan.privateCopy,'utf8')
const stage:any[]=[]
function timed<T>(label:string,fn:()=>T):T{const at=performance.now();try{return fn()}finally{stage.push({label,ms:performance.now()-at})}}
const wasm=readFileSync('frontend/design-client/public/kernel/design_kernel_bg.wasm'),font=readFileSync('frontend/design-client/public/fonts/NotoSansSC.ttf')
await initializePicking({wasm,font})
const ed=new Editor(blank()),prepared=timed('prepareDocumentJson',()=>prepareDocumentJson(raw))
if(!timed('loadPrepared',()=>ed.load(prepared)))throw Error('failed adoption')
timed('warmHistory',()=>ed.warmEditingHistory(ed.state.doc,ed.sessionGeneration))
const results:any[]=[]
const target=Object.values(ed.state.doc.nodes).find(n=>n.kind==='vector'&&!n.children.length&&n.fills.some(f=>['linear','radial','angular','diamond'].includes(f.kind)))
if(!target)throw Error('no gradient target')
const actions=[{label:'opacity',mutate:(n:any)=>{n.opacity=n.opacity>.5?.45:.9}},
 {label:'gradient-color',mutate:(n:any)=>{const f=n.fills.find((p:any)=>p.stops?.length);if(!f)throw Error('gradient has no stops');f.stops[0].color=f.stops[0].color==='#123456'?'#abcdef':'#123456'}},
 {label:'width',mutate:(n:any)=>{n.width+=1}}]
try{
 for(const action of actions){
  const before=ed.state.doc,spans:any[]=[]
  const trace=createCpuStageDiagnostics(true,r=>{if(r.cpuPhase===2)spans.push(r)})
  const at=performance.now();const receipt=trace.run(20,()=>ed.updateProperties([target.id],action.mutate));const ms=performance.now()-at
  const after=ed.state.doc,patch=documentPatch(before,after),batch=compileEditOps(before,after)
  const local=proveLocalEdit(before,after)
  results.push({action:action.label,ms,receiptStatus:receipt?.status,revisionChanged:ed.state.version,changedNodes:Object.keys(patch.nodes).length,changedFields:Object.keys(patch.fields),localEditProof:!!local,historyMode:batch.mode,opCount:batch.mode==='ops'?batch.ops.length:undefined,opTypes:'ops'in batch?batch.ops.map((o:any)=>o.type):[],patchBytes:Buffer.byteLength(JSON.stringify(patch)),spans})
 }
 writeFileSync(output,JSON.stringify({scope:plan.scope,inputSha256:plan.inputSha256,wasmSha256:createHash('sha256').update(wasm).digest('hex'),fontSha256:createHash('sha256').update(font).digest('hex'),nodes:Object.keys(ed.state.doc.nodes).length,targetKind:target.kind,targetGradientKinds:target.fills.map(f=>f.kind),setup:stage,actions:results},null,2)+'\n')
 console.log(JSON.stringify({setup:stage,actions:results}))
}finally{ed.dispose()}
