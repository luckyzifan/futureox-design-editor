// Actual Node -> Rust stdio -> atomic FD -> separate-process reopen. No socket,
// renderer, filesystem or native backend is mocked in this test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Sidecar } from '../../src/sidecar.mjs'
import { DOCUMENT_BYTE_LIMIT } from '../../src/document-capacity.mjs'
const binary=process.env.CORE_DESKTOP_SIDECAR
if(!binary || !path.isAbsolute(binary)) throw Error('CORE_DESKTOP_SIDECAR must name the actual built candidate binary')
test('actual multipart desktop save and independent process reopen retain a document above64MiB',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'core-large-fd-'))
 const target=path.join(root,'large.fd'),recovery=path.join(root,'recovery')
 const size=65*1024*1024
 assert.ok(DOCUMENT_BYTE_LIMIT>size+4096,'this explicit capacity test requires at least1050MiB trusted working memory')
 const document={schemaVersion:6,id:randomUUID(),name:'Large desktop transport',pages:[{id:randomUUID(),name:'Page',background:'#ffffff',children:[]}],nodes:{},extensionData:{payload:'x'.repeat(size)}}
 let sidecar=new Sidecar(binary,recovery,{timeoutMs:120000})
 try{
  const saved=await sidecar.request('save',{path:target,document,expectedHash:null})
  assert.match(saved.hash,/^[0-9a-f]{64}$/)
  await sidecar.stop();sidecar=new Sidecar(binary,recovery,{timeoutMs:120000})
  const opened=await sidecar.request('open',{path:target})
  assert.equal(opened.hash,saved.hash);assert.equal(opened.document.id,document.id)
  assert.equal(opened.document.extensionData.payload.length,size)
  assert.equal(opened.document.extensionData.payload,document.extensionData.payload)
  assert.equal(sidecar.pendingBytes,0);assert.equal(sidecar.pending.size,0)
 }finally{await sidecar.stop();await rm(root,{recursive:true,force:true})}
})
