import {readFile,writeFile,readdir,mkdir}from'node:fs/promises'
import {createHash}from'node:crypto'
import path from'node:path'
import {buildInputs}from'../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),client=path.join(root,'frontend/design-client'),record=path.join(root,'testing/verification-topology-navigation-20261026'),out=process.argv[2]
if(!out)throw Error('Fresh output directory required');await mkdir(out)
Object.assign(process.env,{VITE_DESIGN_RASTER_BACKPRESSURE:'0',VITE_DESIGN_WIDE_RATIONAL_PREFIX:'0',VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE:'0',VITE_DESIGN_LARGE_SHADOW_TENT:'0',VITE_DESIGN_EXACT_WHOLE_TENT_2048:'0'})
const sources=await buildInputs(root),{build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root,publicDir:path.join(client,'public'),configFile:path.join(client,'vite.config.ts'),build:{outDir:out,emptyOutDir:false,sourcemap:true,rollupOptions:{input:['large-wide-hardware','stroke-source-hardware','row-upload-hardware'].map(name=>path.join(record,name+'.html'))}}})
if(JSON.stringify(await buildInputs(root))!==JSON.stringify(sources))throw Error('Source drift during hardware bundle')
const hashes={};async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else hashes[path.relative(out,p)]=createHash('sha256').update(await readFile(p)).digest('hex')}}await walk(out)
await writeFile(path.join(record,'frozen-hardware-20261027.json'),JSON.stringify({sources,artifacts:hashes,output:out,flags:{rasterBackpressure:0,wide:0,largeWide:0,largeShadow:0,wholeTent:0}},null,2));console.log(out)
