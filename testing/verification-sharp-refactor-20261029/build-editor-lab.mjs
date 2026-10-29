import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const [base,version,mode]=process.argv.slice(2),root=process.cwd(),record='testing/verification-sharp-refactor-20261029'
if(!base||!/^v\d+$/.test(version)||!['legacy','native','native-wide','native-exact','native-profile'].includes(mode))throw Error('BASE vN legacy|native|native-wide|native-exact required')
const frozen=JSON.parse(await fs.readFile(path.join(base,'baseline.json'),'utf8')),snapshot=frozen.snapshot
const bundle=path.join(base,version),host=path.join(bundle,'host'),renderer=path.join(bundle,'renderer')
await fs.mkdir(bundle)
await fs.writeFile(path.join(bundle,'fixture.json'),JSON.stringify({purpose:'strict editor navigation'}))
await fs.copyFile(path.join(root,record,'editor-entry.ts'),path.join(snapshot,record,'editor-entry.ts'))
await fs.writeFile(path.join(snapshot,record,'editor.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./editor-entry.ts"></script></body></html>')
const before=await buildInputs(snapshot),{build}=await import(path.join(root,'frontend/design-client/node_modules/vite/dist/node/index.js'))
for(const key of Object.keys(process.env))if(key.startsWith('VITE_DESIGN_'))delete process.env[key]
const flags={VITE_DESIGN_MOTION_QUALITY_TRACE:'1',VITE_DESIGN_NATIVE_VISIBLE_TILES:mode!=='legacy'?'1':'0',...(['native-wide','native-exact'].includes(mode)?{VITE_DESIGN_WIDE_RATIONAL_PREFIX:'1'}:{}),...(mode==='native-exact'?{VITE_DESIGN_EXACT_CLAMP_PREFIX:'1'}:{}),...(mode==='native-profile'?{VITE_DESIGN_GPU_TIMINGS:'1',VITE_DESIGN_QUEUE_WAIT_TIMING:'1'}:{})}
Object.assign(process.env,flags)
await build({root:snapshot,base:'./',publicDir:path.join(snapshot,'frontend/design-client/public'),configFile:path.join(snapshot,'frontend/design-client/vite.config.ts'),
 build:{outDir:renderer,emptyOutDir:false,sourcemap:true,rollupOptions:{input:path.join(snapshot,record,'editor.html')}}})
await fs.writeFile(path.join(renderer,'index.html'),(await fs.readFile(path.join(renderer,record,'editor.html'),'utf8')).replaceAll('../../assets/','./assets/'))
await fs.mkdir(host);await fs.cp(path.join(snapshot,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(path.join(snapshot,'frontend/design-desktop/assets'),path.join(host,'assets'))
await fs.symlink(path.join(base,'products'),path.join(host,'dist'))
await fs.writeFile(path.join(host,'package.json'),JSON.stringify({name:'strict-editor-navigation-validation',type:'module',main:'src/test-launch.mjs'}))
const mapping=path.join(host,'src/render-check.mjs'),code=await fs.readFile(mapping,'utf8')
if(!code.includes("source: 'native-source-check.html'"))throw Error('Validation host mapping changed')
await fs.writeFile(mapping,code.replace("source: 'native-source-check.html'","source: 'index.html'"))
await fs.writeFile(path.join(host,'src/test-launch.mjs'),`process.argv.push('--desktop-isolated-profile','--desktop-render-check=source',${JSON.stringify('--desktop-render-check-root='+renderer)},${JSON.stringify('--desktop-render-check-fixture='+path.join(bundle,'fixture.json'))});await import('./main.mjs');`)
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex'),artifacts={}
async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.isFile())artifacts[path.relative(bundle,p)]=await hash(p)}}
await scan(bundle)
for(const rel of ['bin/design-prepare','bin/design-render','sidecar/futureox-design-desktop-backend'])artifacts['products/'+rel]=await hash(path.join(base,'products',rel))
if(JSON.stringify(await buildInputs(snapshot))!==JSON.stringify(before))throw Error('Frozen production sources drifted')
await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify({sourceDigest:frozen.sourceDigest,flags,host,renderer,artifacts,
 harness:{entry:await hash(path.join(root,record,'editor-entry.ts')),builder:await hash(path.join(root,record,'build-editor-lab.mjs'))}},null,2))
console.log(JSON.stringify({bundle,host,mode,sourceDigest:frozen.sourceDigest}))
