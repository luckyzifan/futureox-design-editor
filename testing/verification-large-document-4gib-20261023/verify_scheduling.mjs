import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Sidecar} from '../../frontend/design-desktop/src/sidecar.mjs'
const directory=path.dirname(fileURLToPath(import.meta.url))
const [backend,sketch,baseline]=process.argv.slice(2)
assert(backend&&sketch,'node verify_scheduling.mjs BACKEND SKETCH [BASELINE_BACKEND]')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const timed=async action=>{const t=performance.now();const value=await action();return {ms:performance.now()-t,value}}
const document={schemaVersion:6,id:'10000000-0000-4000-8000-000000000001',name:'Scheduling probe',pages:[{id:'10000000-0000-4000-8000-000000000002',name:'Page',background:'#ffffff',children:[]}],nodes:{}}
// The archived baseline predates optional scheduling receipts. Its original
// three-field transport is used only for the before/after isolation probe.
class Baseline {
  constructor(binary,root){this.pending=new Map();this.n=0;this.child=spawn(binary,['--recovery-dir',root],{stdio:['pipe','pipe','pipe']});this.child.stderr.resume();this.exit=new Promise(resolve=>this.child.on('close',resolve));createInterface({input:this.child.stdout}).on('line',line=>{const r=JSON.parse(line),p=this.pending.get(r.id);if(!p)return;this.pending.delete(r.id);r.error?p.reject(Object.assign(Error(r.error.message),r.error)):p.resolve(r.result)})}
  request(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n;this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({id,method,params})+'\n')})}
  async stop(){this.child.stdin.end();await this.exit}
}
const results={scope:'real native stdio, actual source file; no GPU or GUI latency claim',thresholds:{ordinarySaveMs:2000,readOrProgressMs:1000,cancelMs:2000},runs:[]}
async function run(binary,old){
 const root=await mkdtemp(path.join(tmpdir(),'futureox-scheduling-'))
 const client=old?new Baseline(binary,path.join(root,'recovery')):new Sidecar(binary,path.join(root,'recovery'))
 const record={baseline:old,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),saveMs:[],controlMs:[],listingMs:[]};let serial=0
 const save=async()=>{const target=path.join(root,`ordinary-${serial++}.fd`);const result=await timed(()=>client.request('save',{path:target,document,expectedHash:null}));record.saveMs.push(result.ms);const reopened=await client.request('open',{path:target});assert.equal(reopened.document.name,document.name);return result.ms}
 try{
  const owner={documentId:randomUUID(),sessionEpoch:1};let finished=false
  const start=performance.now();const opening=client.request('large.open',{path:path.resolve(sketch),...owner}).finally(()=>{finished=true})
  await pause(150)
  if(old){await save()}else{
   while(!finished){
    await save()
    const progress=await timed(()=>client.request('large.progress',{owner,expectedRevision:0}));record.controlMs.push(progress.ms)
    assert.equal(progress.value.owner.documentId,owner.documentId)
    await pause(500)
   }
  }
  const status=await opening;record.importMs=performance.now()-start;record.expandedBytes=status.expandedBytes;record.indexedObjects=status.indexedObjects
  if(!old){
   assert(record.saveMs.length>0)
   const request={owner,expectedRevision:status.revision}
   for(let i=0;i<20;i++){const listing=await timed(()=>client.request('large.children',{...request,offset:0,limit:100}));record.listingMs.push(listing.ms)}
   const rootRows=await client.request('large.children',{...request,offset:0,limit:100})
   const selected=rootRows.items.find(row=>row.bytes<1024*1024);assert(selected)
   const target=path.join(root,'complete.sketch');const exporting=client.request('large.export',{...request,path:target,requestId:randomUUID()})
   await pause(150)
   for(let i=0;i<3;i++){
    await save()
    for(const [method,params]of [['large.status',request],['large.read',{...request,key:selected.key}],['large.progress',request]]){
     const r=await timed(()=>client.request(method,params));record.controlMs.push(r.ms)
    }
   }
   assert.equal((await exporting).exported,true);assert((await stat(target)).size>0)
   const cancelTarget=path.join(root,'cancelled.sketch')
   const work=client.request('large.export',{...request,path:cancelTarget,requestId:randomUUID()}).then(()=>null,error=>error)
   await pause(100)
   const cancelStart=performance.now();const cancel=await client.cancelLargeDocument();const error=await work
   record.cancelMs=performance.now()-cancelStart;record.cancel=cancel
   assert.equal(cancel.requested,1);assert.equal(cancel.running,true);assert(error&&/cancelled/i.test(error.message))
   await assert.rejects(stat(cancelTarget),{code:'ENOENT'})
   await client.request('health')
   assert(Math.max(...record.saveMs)<results.thresholds.ordinarySaveMs)
   assert(Math.max(...record.controlMs)<results.thresholds.readOrProgressMs)
   assert(record.cancelMs<results.thresholds.cancelMs)
  }
  record.passed=true;results.runs.push(record)
 }catch(error){record.error=String(error);results.runs.push(record);throw error}
 finally{await client.stop();await rm(root,{recursive:true,force:true});await writeFile(path.join(directory,'scheduling-results.json'),JSON.stringify(results,null,2)+'\n')}
}
if(baseline)await run(path.resolve(baseline),true)
await run(path.resolve(backend),false)
console.log(JSON.stringify(results,null,2))
