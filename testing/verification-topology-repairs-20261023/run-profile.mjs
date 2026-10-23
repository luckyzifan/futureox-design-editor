// Runs only a copied, owned host. Pass a new output name and optional frozen host.
import {readFileSync,writeFileSync}from'node:fs'
import {spawn}from'node:child_process'
import path from'node:path'
const root=path.dirname(new URL(import.meta.url).pathname),manifest=JSON.parse(readFileSync(path.join(root,'baseline-manifest.json'),'utf8'))
const [name,host,fixture]=process.argv.slice(2)
if(!name||!/^[a-z0-9-]+$/.test(name))throw Error('new run name required')
let script=readFileSync(path.join(root,'profile-frozen.mjs'),'utf8')
if(host){script=script.replace(/const host="[^"]+"/,`const host=${JSON.stringify(path.resolve(host))}`);script=script.replace(/await cp\("[^"]+identity.json",path.join\(output,'identity.json'\)\)/,`await cp(${JSON.stringify(path.resolve(host,'../identity.json'))},path.join(output,'identity.json'))`)}
const file=path.join(manifest.privateRuntimeRoot,name+'-runner.mjs')
// Resolve test imports from the project independent of the temporary runner path.
script=script.replace("const desktop=path.resolve('frontend/design-desktop')",`const desktop=${JSON.stringify(path.resolve('frontend/design-desktop'))}`)
writeFileSync(file,script)
const child=spawn(process.execPath,[file,fixture||manifest.controlsFixture,path.join(manifest.privateRuntimeRoot,name)],{stdio:'inherit',env:{...process.env,DESIGN_PROFILE_VISIBLE:process.env.DESIGN_PROFILE_VISIBLE||'0',DESIGN_PROFILE_FIT:'0',DESIGN_PROFILE_ZOOMS:process.env.DESIGN_PROFILE_ZOOMS||'50,100,400,47.3',CORE_DOCUMENT_MEMORY_BYTES:'1219977216',CORE_DOCUMENT_MEMORY_INHERITED:'1'}})
child.on('exit',code=>{process.exitCode=code??1})
