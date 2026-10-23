import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {Editor} from '../../frontend/design-client/src/engine'
import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {prepareDocumentJson} from '../../frontend/design-client/src/prepared-document'
import {blank} from '../../frontend/design-client/src/model'
import {resizeNodeDimension} from '../../frontend/design-client/src/selection-properties'
import {documentPatch} from '../../frontend/design-client/src/document-patch'
import {createCpuStageDiagnostics} from '../../frontend/design-client/src/cpu-stage-diagnostics'
const plan=JSON.parse(readFileSync(new URL('./probe-plan.json',import.meta.url),'utf8'))
await initializePicking({wasm:readFileSync('frontend/design-client/public/kernel/design_kernel_bg.wasm'),font:readFileSync('frontend/design-client/public/fonts/NotoSansSC.ttf')})
const editor=new Editor(blank())
try{
 if(!editor.load(prepareDocumentJson(readFileSync(plan.privateCopy,'utf8'))))throw Error('adoption failed')
 editor.warmEditingHistory(editor.state.doc,editor.sessionGeneration)
 const before=editor.state.doc,id='0D747267-A0CA-40C0-BEFD-846C10CD98F2',target=before.nodes[id]
 if(!target?.instance||target.width!==100)throw Error('GUI target mismatch')
 const spans:any[]=[],trace=createCpuStageDiagnostics(true,r=>{if(r.cpuPhase===2)spans.push(r)})
 const at=performance.now();trace.run(20,()=>editor.updateProperties([id],n=>resizeNodeDimension(n,'width',120,editor.state.doc)));const totalMs=performance.now()-at
 const after=editor.state.doc,patch=documentPatch(before,after),directory=dirname(plan.privateCopy)
 const source=JSON.stringify(before),patchJson=JSON.stringify(patch)
 writeFileSync(join(directory,'prepared-before.json'),source);writeFileSync(join(directory,'instance-patch.json'),patchJson)
 const parents=new Map<string,string>();for(const n of Object.values(before.nodes))for(const c of n.children)parents.set(c,n.id)
 let chain:string|undefined=id;const lineage:any[]=[];while(chain){const n=before.nodes[chain];lineage.push({kind:n.kind,instance:!!n.instance,instanceOrigin:!!n.instanceOrigin,boolean:!!n.booleanOperation,component:!!n.component});chain=parents.get(chain)}
 const result={scope:plan.scope,inputSha256:plan.inputSha256,originalWidth:target.width,afterWidth:after.nodes[id].width,sourceCodeUnits:source.length,sourceBytes:Buffer.byteLength(source),preparedNodes:Object.keys(before.nodes).length,totalMs,changedNodes:Object.keys(patch.nodes).length,changedRootFields:Object.keys(patch.fields),patchBytes:Buffer.byteLength(patchJson),changeFields:[...new Set(Object.keys(patch.nodes).flatMap(k=>Object.keys(patch.nodes[k]||{}).filter(f=>JSON.stringify((before.nodes[k]as any)?.[f])!==JSON.stringify((patch.nodes[k]as any)?.[f]))))],lineage,spans}
 writeFileSync(new URL('./instance-probe.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{editor.dispose()}
