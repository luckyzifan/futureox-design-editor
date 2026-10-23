import {readFile,writeFile,mkdir,cp} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
const root=process.cwd(),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client'),out=path.join(root,'testing/verification-topology-repairs-20261023')
const manifest=JSON.parse(await readFile(path.join(out,'baseline-manifest.json'),'utf8')),name=process.argv[2];if(!/^[a-z0-9-]+$/.test(name))throw Error('New owned host name required')
const host=path.join(manifest.privateRuntimeRoot,name,'host');await mkdir(host,{recursive:false})
for(const dir of ['src','assets'])await cp(path.join(desktop,dir),path.join(host,dir),{recursive:true})
for(const dir of ['bin','sidecar','fonts'])await cp(path.join(desktop,'dist',dir),path.join(host,'dist',dir),{recursive:true})
await writeFile(path.join(host,'package.json'),JSON.stringify({name:'owned-topology-verification',version:'0.0.0',type:'module',main:'src/main.mjs'}))
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root:client,configFile:path.join(client,'vite.config.ts'),base:'./',define:{'import.meta.env.DEV':'true'},build:{outDir:path.join(host,'dist/renderer'),emptyOutDir:true,sourcemap:true}})
const identity={host,sourceScope:'combined local source, independent copied binaries',experimentalFlags:'default off',nativeSha256:createHash('sha256').update(await readFile(path.join(host,'dist/bin/design-prepare'))).digest('hex'),wasmSha256:createHash('sha256').update(await readFile(path.join(host,'dist/renderer/kernel/design_kernel_bg.wasm'))).digest('hex')}
await writeFile(path.join(host,'../identity.json'),JSON.stringify(identity,null,2));await writeFile(path.join(out,name+'-identity.json'),JSON.stringify(identity,null,2));console.log(JSON.stringify(identity))
