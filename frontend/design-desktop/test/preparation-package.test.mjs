import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

test('desktop package staging includes the preparation worker and its frame decoder',async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),'preparation-package-'))
 const root=path.join(temporary,'frontend/design-desktop')
 try{
  for(const directory of ['scripts','src','assets/branding','dist/renderer','node_modules/@electron/packager'])
   await mkdir(path.join(root,directory),{recursive:true})
  await cp(new URL('../scripts/package.mjs',import.meta.url),path.join(root,'scripts/package.mjs'))
  await cp(new URL('../scripts/package-source.mjs',import.meta.url),path.join(root,'scripts/package-source.mjs'))
  await cp(new URL('../scripts/mcp-bundle.mjs',import.meta.url),path.join(root,'scripts/mcp-bundle.mjs'))
  await cp(new URL('../../design-mcp/src',import.meta.url),path.join(temporary,'frontend/design-mcp/src'),{recursive:true})
  await mkdir(path.join(temporary,'docs'),{recursive:true})
  await cp(new URL('../../../docs/ELECTRON_LOCAL_MCP.zh-CN.md',import.meta.url),path.join(temporary,'docs/ELECTRON_LOCAL_MCP.zh-CN.md'))
  await cp(new URL('../package.json',import.meta.url),path.join(root,'package.json'))
  for(const name of ['preparation-worker.mjs','preparation-frame.mjs'])
   await cp(new URL('../src/'+name,import.meta.url),path.join(root,'src',name))
  const icon = 'branding/futureox-desgin.png'
  await cp(new URL('../assets/'+icon,import.meta.url),path.join(root,'assets',icon))
  // Execute the real staging script with only the external Electron packager
  // stubbed. No Electron download, native bundle or GUI is involved.
  await writeFile(path.join(root,'node_modules/@electron/packager/package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}))
  await writeFile(path.join(root,'node_modules/@electron/packager/index.mjs'),'export async function packager(){return []}\n')
  const env={...process.env};delete env.ELECTRON_ZIP_DIR
  const result=spawnSync(process.execPath,[path.join(root,'scripts/package.mjs')],{encoding:'utf8',env,timeout:10000})
  assert.equal(result.status,0,result.stderr||result.error?.message)
  assert.deepEqual(await readFile(path.join(root,'dist/package-app/assets',icon)),
   await readFile(new URL('../assets/'+icon,import.meta.url)))
  const staged=path.join(root,'dist/package-app/src')
  for(const name of ['preparation-worker.mjs','preparation-frame.mjs'])
   assert.deepEqual(await readFile(path.join(staged,name)),await readFile(path.join(root,'src',name)))
  const {NativePreparationFrame}=await import(pathToFileURL(path.join(staged,'preparation-frame.mjs')).href)
  assert.equal(new NativePreparationFrame().append(Buffer.from('FPR')),false)
 }finally{await rm(temporary,{recursive:true,force:true})}
})
