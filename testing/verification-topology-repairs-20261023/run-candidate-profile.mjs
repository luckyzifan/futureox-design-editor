import{readFile,writeFile,mkdir,cp}from'node:fs/promises'
import{spawn}from'node:child_process'
import path from'node:path'
import{createHash}from'node:crypto'
const root=process.cwd(),out=path.join(root,'testing/verification-topology-repairs-20261023'),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client')
const manifest=JSON.parse(await readFile(path.join(out,'baseline-manifest.json'),'utf8')),name=process.argv[2]||'candidate-profile',fixture=process.argv[3]||manifest.controlsFixture
const parent=path.join(manifest.privateRuntimeRoot,name+'-runtime'),host=path.join(parent,'host');await mkdir(parent,{recursive:true})
await cp(path.join(desktop,'src'),path.join(host,'src'),{recursive:true});await cp(path.join(desktop,'assets'),path.join(host,'assets'),{recursive:true})
await writeFile(path.join(host,'package.json'),JSON.stringify({name:'owned-topology-profile',version:'0.0.0',type:'module',main:'src/main.mjs'}))
for(const dir of ['bin','sidecar','fonts'])await cp(path.join(desktop,'dist',dir),path.join(host,'dist',dir),{recursive:true})
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
process.env.VITE_DESIGN_GPU_TIMINGS='1';process.env.VITE_DESIGN_TRACE_PASSES='tile'
await build({root:client,configFile:path.join(client,'vite.config.ts'),base:'./',define:{'import.meta.env.DEV':'true'},build:{outDir:path.join(host,'dist/renderer'),emptyOutDir:true,sourcemap:true}})
const input=await readFile(fixture),identity={fixtureSha256:createHash('sha256').update(input).digest('hex'),scope:'owned Electron; profiling on; current combined source',hidden:process.env.DESIGN_PROFILE_VISIBLE!=='1',nativeSha256:createHash('sha256').update(await readFile(path.join(host,'dist/bin/design-prepare'))).digest('hex'),wasmSha256:createHash('sha256').update(await readFile(path.join(host,'dist/renderer/kernel/design_kernel_bg.wasm'))).digest('hex')}
await writeFile(path.join(parent,'identity.json'),JSON.stringify(identity,null,2))
let script=await readFile(path.join(out,'profile-frozen.mjs'),'utf8')
script=script.replace(/const host="[^"]+"/,`const host=${JSON.stringify(host)}`).replace(/await cp\("[^"]+identity.json",path.join\(output,'identity.json'\)\)/,`await cp(${JSON.stringify(path.join(parent,'identity.json'))},path.join(output,'identity.json'))`)
script=script.replace("const desktop=path.resolve('frontend/design-desktop')",`const desktop=${JSON.stringify(desktop)}`)
const runner=path.join(parent,'runner.mjs');await writeFile(runner,script)
const child=spawn(process.execPath,[runner,fixture,path.join(manifest.privateRuntimeRoot,name)],{stdio:'inherit',env:{...process.env,DESIGN_PROFILE_VISIBLE:process.env.DESIGN_PROFILE_VISIBLE||'0',DESIGN_PROFILE_FIT:'0',DESIGN_PROFILE_ZOOMS:process.env.DESIGN_PROFILE_ZOOMS||'50,100,400,47.3',CORE_DOCUMENT_MEMORY_BYTES:'1219977216',CORE_DOCUMENT_MEMORY_INHERITED:'1'}})
child.on('exit',code=>{process.exitCode=code??1})
