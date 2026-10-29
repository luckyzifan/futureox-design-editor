import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),base=path.resolve(process.argv[2]||''),version=process.argv[3]||'v1'
if(!/^v\d+$/.test(version)||!process.argv[2])throw Error('Usage: node build-lab.mjs BASE vN')
const frozen=JSON.parse(await fs.readFile(path.join(base,'baseline.json'),'utf8')),snapshot=frozen.snapshot
const record='testing/verification-render-refactor-baseline-20261028',bundle=path.join(base,version),host=path.join(bundle,'host'),renderer=path.join(bundle,'renderer')
await fs.mkdir(bundle)
await fs.copyFile(path.join(root,record,'fixture.json'),path.join(bundle,'fixture.json'))
for(const name of ['index.html','entry.tsx','report-contract.mjs','fixture.json'])await fs.copyFile(path.join(root,record,name),path.join(snapshot,record,name))
const before=await buildInputs(snapshot),{build}=await import(path.join(root,'frontend/design-client/node_modules/vite/dist/node/index.js'))
const flags={VITE_DESIGN_MOTION_QUALITY_TRACE:'1'}
// Rendering experiments retain the repository's defaults. This single flag
// requests detailed geometry diagnostics and is reported as measurement cost.
for(const key of Object.keys(process.env))if(key.startsWith('VITE_DESIGN_'))delete process.env[key]
Object.assign(process.env,flags)
await build({root:snapshot,base:'./',publicDir:path.join(snapshot,'frontend/design-client/public'),configFile:path.join(snapshot,'frontend/design-client/vite.config.ts'),
 build:{outDir:renderer,emptyOutDir:false,sourcemap:true,rollupOptions:{input:path.join(snapshot,record,'index.html')}}})
const html=await fs.readFile(path.join(renderer,record,'index.html'),'utf8')
await fs.writeFile(path.join(renderer,'index.html'),html.replaceAll('../../assets/','./assets/'))
await fs.mkdir(host);await fs.cp(path.join(snapshot,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(path.join(snapshot,'frontend/design-desktop/assets'),path.join(host,'assets'))
await fs.symlink(path.join(base,'products'),path.join(host,'dist'))
await fs.writeFile(path.join(host,'package.json'),JSON.stringify({name:'topology-baseline-validation',version:'1.0.0',type:'module',main:'src/test-launch.mjs'},null,2))
const mapping=path.join(host,'src/render-check.mjs'),code=await fs.readFile(mapping,'utf8')
if(!code.includes("source: 'native-source-check.html'"))throw Error('Isolated validation mapping changed')
await fs.writeFile(mapping,code.replace("source: 'native-source-check.html'","source: 'index.html'"))
const launch=`import {app,BrowserWindow,dialog} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
const output=${JSON.stringify(bundle)}, fixture=${JSON.stringify(frozen.fixture.path)};
process.env.CORE_RENDER_DIAGNOSTICS='detail';
// Test-only native dialog selection. The real production import/ownership
// checks remain intact and the renderer receives no arbitrary-path API.
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});
process.argv.push('--desktop-isolated-profile','--desktop-render-check=source',${JSON.stringify('--desktop-render-check-root='+renderer)},${JSON.stringify('--desktop-render-check-fixture='+path.join(bundle,'fixture.json'))});
const screenshots=[];
app.on('web-contents-created',(_event,contents)=>{
 contents.on('console-message',(...args)=>{
  const message=typeof args[0]?.message==='string'?args[0].message:args[2];
  if(typeof message!=='string')return;
  if(message.startsWith('GPU TOPOLOGY CASE ')){
   const row=JSON.parse(message.slice('GPU TOPOLOGY CASE '.length));
   if(row.status==='complete'&&/^[a-z0-9-]+$/.test(row.id))screenshots.push(contents.capturePage().then(image=>fs.writeFile(path.join(output,'gui-'+row.id+'.png'),image.toPNG())).catch(error=>console.error('GUI_CAPTURE_ERROR '+String(error))));
  }
  if(message.startsWith('GPU TOPOLOGY_TEST_DONE '))void (async()=>{await Promise.allSettled(screenshots);await fs.writeFile(path.join(output,'gpu-info.json'),JSON.stringify(await app.getGPUInfo('basic'),null,2));app.quit()})().catch(error=>{console.error(error);app.quit()});
 });
});
await import('./main.mjs');
`
await fs.writeFile(path.join(host,'src/test-launch.mjs'),launch)
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex'),artifacts={}
async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.isFile())artifacts[path.relative(bundle,p)]=await hash(p)}}
await scan(bundle)
for(const rel of ['bin/design-prepare','bin/design-render','sidecar/futureox-design-desktop-backend'])artifacts['products/'+rel]=await hash(path.join(base,'products',rel))
if(JSON.stringify(await buildInputs(snapshot))!==JSON.stringify(before))throw Error('Frozen production sources drifted')
const manifest={format:1,builtAt:new Date().toISOString(),sourceDigest:frozen.sourceDigest,flags,host,renderer,artifacts,harness:{}}
for(const name of ['entry.tsx','index.html','report-contract.mjs','fixture.json','build-lab.mjs'])manifest.harness[name]=await hash(path.join(root,record,name))
await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({host,bundle,sourceDigest:frozen.sourceDigest}))
