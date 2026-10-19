import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

test('desktop package staging includes the preparation worker and its frame decoder',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'preparation-package-'))
 try{
  for(const directory of ['scripts','src','dist/renderer','node_modules/@electron/packager'])
   await mkdir(path.join(root,directory),{recursive:true})
  await cp(new URL('../scripts/package.mjs',import.meta.url),path.join(root,'scripts/package.mjs'))
  await cp(new URL('../package.json',import.meta.url),path.join(root,'package.json'))
  for(const name of ['preparation-worker.mjs','preparation-frame.mjs'])
   await cp(new URL('../src/'+name,import.meta.url),path.join(root,'src',name))
  // Execute the real staging script with only the external Electron packager
  // stubbed. No Electron download, native bundle or GUI is involved.
  await writeFile(path.join(root,'node_modules/@electron/packager/package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}))
  await writeFile(path.join(root,'node_modules/@electron/packager/index.mjs'),'export async function packager(){return []}\n')
  const env={...process.env};delete env.ELECTRON_ZIP_DIR
  const result=spawnSync(process.execPath,[path.join(root,'scripts/package.mjs')],{encoding:'utf8',env,timeout:10000})
  assert.equal(result.status,0,result.stderr||result.error?.message)
  const staged=path.join(root,'dist/package-app/src')
  for(const name of ['preparation-worker.mjs','preparation-frame.mjs'])
   assert.deepEqual(await readFile(path.join(staged,name)),await readFile(path.join(root,'src',name)))
  const {NativePreparationFrame}=await import(pathToFileURL(path.join(staged,'preparation-frame.mjs')).href)
  assert.equal(new NativePreparationFrame().append(Buffer.from('FPR')),false)
 }finally{await rm(root,{recursive:true,force:true})}
})
