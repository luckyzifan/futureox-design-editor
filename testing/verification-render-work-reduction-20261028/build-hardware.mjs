import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
const root=process.cwd(),record=path.join(root,'testing/verification-render-work-reduction-20261028'),out=process.argv[2]
if(!out)throw Error('Fresh output directory required');await mkdir(out)
const flags={VITE_DESIGN_MIXED_SOLID_RUNS:'1',VITE_DESIGN_CONSTANT_COVERAGE:process.argv[3]==='all-candidates'?'1':'0',VITE_DESIGN_FUSED_GRADIENT:'1',VITE_DESIGN_EXACT_CLAMP_PREFIX:'0',VITE_DESIGN_OPAQUE_SOLID_BATCH:'0',VITE_DESIGN_GPU_TIMINGS:'0'}
Object.assign(process.env,flags)
const inputs=await buildInputs(root),{build}=await import(path.join(root,'frontend/design-client/node_modules/vite/dist/node/index.js'))
const harnessInputs={};for(const name of ['hardware.ts','hardware.html','edge.ts','edge.html','build-hardware.mjs'])harnessInputs[name]=createHash('sha256').update(await readFile(path.join(record,name))).digest('hex')
await build({root,publicDir:path.join(root,'frontend/design-client/public'),configFile:path.join(root,'frontend/design-client/vite.config.ts'),build:{outDir:out,emptyOutDir:false,sourcemap:true,rollupOptions:{input:[path.join(record,'hardware.html'),path.join(record,'edge.html')]}}})
if(JSON.stringify(await buildInputs(root))!==JSON.stringify(inputs))throw Error('Source drift during build')
const artifacts={};async function walk(dir){for(const f of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())await walk(p);else artifacts[path.relative(out,p)]=createHash('sha256').update(await readFile(p)).digest('hex')}}await walk(out)
await writeFile(out+'/provenance.json',JSON.stringify({inputs,harnessInputs,artifacts,flags},null,2));console.log(out)
