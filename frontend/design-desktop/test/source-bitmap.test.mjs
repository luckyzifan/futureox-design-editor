import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {serveSourceBitmap} from '../src/source-bitmap.mjs'
test('native source reads are owner-scoped; sparse samples preserve original texels and edge neighbours',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'source-texels-')),owner='sample-1',key='a'.repeat(64)+'-4x3',dir=path.join(root,'large-documents',owner,'bitmaps')
 try{
  await mkdir(dir,{recursive:true});const pixels=Buffer.from(Array.from({length:48},(_,i)=>i))
  await writeFile(path.join(dir,key+'.rgba'),pixels);await writeFile(path.join(dir,key+'.png'),Buffer.from([1,2,3]))
  const url='design-app://app/source-image/'+owner+'/'+key+'.png',active=id=>id===owner
  assert.equal((await serveSourceBitmap(new Request(url),()=>false,root)).status,403)
  assert.equal((await serveSourceBitmap(new Request(url+'?untrusted=1'),active,root)).status,403)
  assert.deepEqual(new Uint8Array(await (await serveSourceBitmap(new Request(url),active,root)).arrayBuffer()),new Uint8Array([1,2,3]))
  const sample=async(data,pairs=false)=>new Uint8Array(await (await serveSourceBitmap(new Request(url+'?samples=1'+(pairs?'&pairs=1':''),{method:'POST',body:new Uint32Array(data)}),active,root)).arrayBuffer())
  assert.deepEqual([...await sample([2,2,3,0,2,0])], [11,8,3,0].flatMap(i=>[...pixels.subarray(i*4,i*4+4)]))
  assert.deepEqual([...await sample([2,1,0,1,3,2],true)], [4,5,11,11,8,9,11,11].flatMap(i=>[...pixels.subarray(i*4,i*4+4)]))
  await assert.rejects(sample([1,1,4,0]))
 }finally{await rm(root,{recursive:true,force:true})}
})
