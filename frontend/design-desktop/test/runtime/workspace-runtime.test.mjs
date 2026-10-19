import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const { Sidecar } = await import(process.env.CORE_DESKTOP_TEST_SOURCE
 ? new URL('sidecar.mjs',process.env.CORE_DESKTOP_TEST_SOURCE).href
 : new URL('../../src/sidecar.mjs',import.meta.url).href)
const binary=process.env.CORE_DESKTOP_SIDECAR
if(!binary || !path.isAbsolute(binary)) throw new Error('CORE_DESKTOP_SIDECAR must identify the actual owned Rust binary')
const corpus=JSON.parse(await readFile(new URL('../../../../testing/fixtures/design/precision-corpus.json',import.meta.url),'utf8'))
async function fixture(work){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'forma-workspace-runtime-')))
 const recovery=path.join(root,'recovery');await mkdir(recovery)
 const options={workspaceDb:path.join(root,'workspace.sqlite3'),timeoutMs:15000}
 let child=new Sidecar(binary,recovery,options)
 try {await work({root,child,restart:async()=>{await child.stop();child=new Sidecar(binary,recovery,options);return child}})}
 finally{await child.stop();await rm(root,{recursive:true,force:true})}
}
function document(){const d=structuredClone(corpus.cases[0].document);d.id=randomUUID();d.name='本地 SQLite 真实链路';return d}
test('real JavaScript bridge and Rust workspace preserve snapshots across owned process restart',()=>fixture(async({child,restart})=>{
 const health=await child.request('health');assert.equal(health.workspaceAvailable,true)
 const doc=document(),mutationId=randomUUID()
 const first=await child.request('workspace.commit',{document:doc,expectedRevision:null,mutationId})
 assert.equal(first.revision,1)
 const retried=await child.request('workspace.commit',{document:doc,expectedRevision:null,mutationId});assert.deepEqual(retried,first)
 const next=await restart(),opened=await next.request('workspace.open',{id:doc.id})
 assert.deepEqual(opened.document,doc);assert.equal(opened.hash,first.hash)
 assert.equal((await next.request('workspace.list')).documents.length,1)
}))
test('real workspace rejects conflicting writes and keeps revision history and trash recoverable',()=>fixture(async({child})=>{
 const doc=document();await child.request('workspace.commit',{document:doc,expectedRevision:null,mutationId:randomUUID()})
 const changed={...doc,name:'修改后的设计'}
 await child.request('workspace.commit',{document:changed,expectedRevision:1,mutationId:randomUUID()})
 await assert.rejects(child.request('workspace.commit',{document:{...doc,name:'stale'},expectedRevision:1,mutationId:randomUUID()}),e=>e.code==='WORKSPACE_CONFLICT')
 assert.equal((await child.request('workspace.open',{id:doc.id})).document.name,changed.name)
 assert.equal((await child.request('workspace.revisions',{id:doc.id})).revisions.length,2)
 const restored=await child.request('workspace.restore',{id:doc.id,revision:1,expectedRevision:2,mutationId:randomUUID()})
 assert.equal(restored.revision,3);assert.deepEqual(restored.document,doc)
 const trashed=await child.request('workspace.trash',{id:doc.id,expectedRevision:3,mutationId:randomUUID(),deleted:true})
 assert.equal(trashed.deleted,true)
 assert.equal((await child.request('workspace.list')).documents.length,0)
 assert.equal((await child.request('workspace.list',{includeDeleted:true})).documents.length,1)
 await child.request('workspace.trash',{id:doc.id,expectedRevision:trashed.revision,mutationId:randomUUID(),deleted:false})
 assert.deepEqual((await child.request('workspace.open',{id:doc.id})).document,doc)
}))
test('portable forma files preserve exact authored glass, texture, images and extension fields through SQLite',()=>fixture(async({root,child,restart})=>{
 const inputs=[8,9,11].map(index=>{
   const doc=structuredClone(corpus.cases[index].document)
   doc.id=randomUUID();doc.name=`便携往返 ${index}`
   doc.customMetadata={text:'字节资源和扩展字段完整保留 🧪',numeric:[0.125,1e-12],nested:{enabled:true}}
   return doc
 })
 const saved=[]
 for(const [index,doc] of inputs.entries()){
   const committed=await child.request('workspace.commit',{document:doc,expectedRevision:null,mutationId:randomUUID()})
   const opened=await child.request('workspace.open',{id:doc.id})
   assert.deepEqual(opened.document,doc)
   const target=path.join(root,`roundtrip-${index}.fd`)
   await child.request('save',{path:target,document:opened.document,expectedHash:null})
   const portable=await readFile(target)
   assert.equal(portable.subarray(0,4).toString(),'FXDK')
   assert.equal(portable.readUInt16LE(4),2)
   const imported=await child.request('open',{path:target})
   assert.deepEqual(imported.document,doc)
   saved.push({id:doc.id,hash:committed.hash})
 }
 const next=await restart()
 for(const [index,entry] of saved.entries()){
   const reopened=await next.request('workspace.open',{id:entry.id})
   assert.deepEqual(reopened.document,inputs[index]);assert.equal(reopened.hash,entry.hash)
 }
}))
