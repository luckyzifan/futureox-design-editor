import {readFile,writeFile,readdir}from'node:fs/promises'
import {createHash}from'node:crypto'
import path from'node:path'
import {buildInputs}from'../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),client=path.join(root,'frontend/design-client'),out=process.argv[2]
if(!out||!path.isAbsolute(out))throw Error('Expected an absolute completed desktop build directory')
const manifest=JSON.parse(await readFile(path.join(out,'build-manifest.json'),'utf8'))
const sources=await buildInputs(root)
if(JSON.stringify(sources)!==JSON.stringify(manifest.sources))throw Error('Desktop build does not match current source')
Object.assign(process.env,{VITE_DESIGN_RASTER_BACKPRESSURE:'0',VITE_DESIGN_WIDE_RATIONAL_PREFIX:'0',VITE_DESIGN_WIDE_RATIONAL_PREFIX_LARGE:'0',VITE_DESIGN_LARGE_SHADOW_TENT:'0',VITE_DESIGN_EXACT_WHOLE_TENT_2048:'0'})
const {build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root:client,base:'./',configFile:path.join(client,'vite.config.ts'),build:{outDir:path.join(out,'renderer'),emptyOutDir:false,sourcemap:true,rollupOptions:{input:path.join(client,'native-source-check.html')}}})
if(JSON.stringify(await buildInputs(root))!==JSON.stringify(sources))throw Error('Source changed during native canvas check build')
const artifacts={}
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else artifacts[path.relative(out,p)]=createHash('sha256').update(await readFile(p)).digest('hex')}}
await walk(out)
await writeFile(path.join(out,'native-source-check-manifest.json'),JSON.stringify({sources,artifacts},null,2))
console.log('Native source canvas check built:',out)
