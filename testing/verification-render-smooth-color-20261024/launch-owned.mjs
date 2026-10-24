import {mkdtemp,cp,mkdir,readFile,writeFile,open} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import path from 'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-render-smooth-color-20261024'),desktop=path.join(root,'frontend/design-desktop'),client=path.join(root,'frontend/design-client')
const own=await mkdtemp(path.join(tmpdir(),'render-smooth-gui-')),host=path.join(own,'host');await mkdir(host)
for(const name of ['src','assets','dist'])await cp(path.join(desktop,name),path.join(host,name),{recursive:true})
await cp(path.join(out,'profile-owned.mjs'),path.join(host,'src/profile-owned.mjs'))
await writeFile(path.join(host,'src/main.mjs'),(await readFile(path.join(host,'src/main.mjs'),'utf8'))+"\nimport './profile-owned.mjs'\n")
await writeFile(path.join(host,'package.json'),JSON.stringify({name:'owned-render-repair-verification',version:'0.0.0',type:'module',main:'src/main.mjs'}))
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root:client,configFile:path.join(client,'vite.config.ts'),base:'./',define:{'import.meta.env.DEV':'true'},build:{outDir:path.join(host,'dist/renderer'),emptyOutDir:true,sourcemap:true}})
const log=await open(path.join(out,'owned-gui.log'),'a')
const child=spawn(path.join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[host,'--desktop-isolated-profile'],{env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='ELECTRON_RUN_AS_NODE')),TMPDIR:own,CORE_OWNED_PROFILE_OUTPUT:out,CORE_RENDER_DIAGNOSTICS:'detail',CORE_DOCUMENT_MEMORY_BYTES:'1317748736',CORE_DOCUMENT_MEMORY_INHERITED:'1'},detached:true,stdio:['ignore',log.fd,log.fd]})
child.unref();await log.close()
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
const identity={own,host,pid:child.pid,wasmSha256:await hash(path.join(host,'dist/renderer/kernel/design_kernel_bg.wasm')),nativeSha256:await hash(path.join(host,'dist/bin/design-prepare')),backendSha256:await hash(path.join(host,'dist/sidecar/futureox-design-desktop-backend'))}
await writeFile(path.join(out,'owned-gui-identity.json'),JSON.stringify(identity,null,2));console.log(JSON.stringify(identity))
