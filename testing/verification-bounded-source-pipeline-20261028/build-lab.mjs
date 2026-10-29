import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
import {installSidecar} from '../../frontend/design-desktop/scripts/install-sidecar.mjs'
const root=process.cwd(),client=path.join(root,'frontend/design-client')
const suffix=process.argv[2]||''
if(suffix&&!/^-[-a-z0-9]+$/.test(suffix))throw Error('Invalid isolated build suffix')
const out='/tmp/futureox-bounded-pipeline-build-20261028'+suffix,lab='/tmp/futureox-bounded-pipeline-lab-20261028'+suffix,host='/tmp/futureox-bounded-pipeline-host-20261028'+suffix
const sources=await buildInputs(root),{build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await fs.mkdir(out)
await build({root:client,base:'./',configFile:path.join(client,'vite.config.ts'),build:{outDir:path.join(out,'renderer'),emptyOutDir:true,sourcemap:true,rollupOptions:{input:{app:path.join(client,'index.html'),pipeline:path.join(client,'verification/bounded-pipeline/index.html')}}}})
if(JSON.stringify(await buildInputs(root))!==JSON.stringify(sources))throw Error('Build source changed')
for(const dir of ['bin','sidecar','fonts'])await fs.mkdir(path.join(out,dir))
const target='/tmp/futureox-bounded-pipeline-target-20261028/desktop-dev'
for(const [file,dir] of [['design-prepare','bin'],['design-render','bin'],['futureox-design-desktop-backend','sidecar']])await installSidecar(path.join(target,file),path.join(out,dir,file))
for(const name of ['NotoSansSC.ttf','OFL.txt','source.json'])await fs.copyFile(path.join(client,'public/fonts',name),path.join(out,'fonts',name))
await fs.mkdir(lab);await fs.cp(path.join(out,'renderer'),path.join(lab,'renderer'),{recursive:true})
// The approved check stays at the same production APP_URL; no IPC/security
// allowlist is weakened to admit a second page or debugger.
await fs.copyFile(path.join(lab,'renderer/verification/bounded-pipeline/index.html'),path.join(lab,'renderer/index.html'))
let html=await fs.readFile(path.join(lab,'renderer/index.html'),'utf8')
html=html.replaceAll('../../assets/','./assets/');await fs.writeFile(path.join(lab,'renderer/index.html'),html)
for(const dir of ['bin','sidecar','fonts'])await fs.symlink(path.join(out,dir),path.join(lab,dir))
await fs.mkdir(host);await fs.cp(path.join(root,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(path.join(root,'frontend/design-desktop/assets'),path.join(host,'assets'));await fs.symlink(lab,path.join(host,'dist'))
const pkg=JSON.parse(await fs.readFile(path.join(root,'frontend/design-desktop/package.json'),'utf8'));pkg.main='src/pipeline-launch.mjs';await fs.writeFile(path.join(host,'package.json'),JSON.stringify(pkg,null,2))
const renderCheck=path.join(host,'src/render-check.mjs'),code=await fs.readFile(renderCheck,'utf8')
if(!code.includes("source: 'native-source-check.html'"))throw Error('Check entry anchor missing')
await fs.writeFile(renderCheck,code.replace("source: 'native-source-check.html'","source: 'index.html'"))
await fs.writeFile(path.join(host,'src/pipeline-launch.mjs'),`process.env.CORE_RENDER_DIAGNOSTICS='detail';\nprocess.argv.push('--desktop-isolated-profile','--desktop-render-check=source',${JSON.stringify('--desktop-render-check-root='+path.join(lab,'renderer'))},${JSON.stringify('--desktop-render-check-fixture='+path.join(root,'testing/verification-bounded-source-pipeline-20261028/fixture.json'))});\nawait import('./main.mjs');\n`)
const artifacts={};async function scan(dir,prefix=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name),name=prefix+e.name;if(e.isDirectory())await scan(p,name+'/');else if(e.isFile())artifacts[name]=createHash('sha256').update(await fs.readFile(p)).digest('hex')}}
await scan(out)
await fs.writeFile(path.join(out,'build-manifest.json'),JSON.stringify({sources,artifacts,profile:'desktop-dev',builtAt:new Date().toISOString(),root,lab,host},null,2))
await fs.copyFile(path.join(out,'build-manifest.json'),path.join(root,'testing/verification-bounded-source-pipeline-20261028/build-manifest.json'))
console.log(JSON.stringify({out,lab,host}))
