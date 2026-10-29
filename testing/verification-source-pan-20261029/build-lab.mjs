import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),client=path.join(root,'frontend/design-client'),products=process.argv[2],output=process.argv[3]
if(!products||!output)throw Error('Usage: build-lab.mjs PRODUCTS FRESH_LAB')
const manifest=JSON.parse(await fs.readFile(path.join(products,'build-manifest.json'),'utf8'))
assert.deepEqual(await buildInputs(root),manifest.sources,'Runtime sources drifted after product build')
await fs.mkdir(output);const renderer=path.join(output,'renderer'),{build}=await import(path.join(client,'node_modules/vite/dist/node/index.js'))
await build({root:client,base:'./',configFile:path.join(client,'vite.config.ts'),build:{outDir:renderer,emptyOutDir:true,sourcemap:true,rollupOptions:{input:{sourcePan:path.join(client,'verification/source-pan/index.html')}}}})
let html=await fs.readFile(path.join(renderer,'verification/source-pan/index.html'),'utf8');html=html.replaceAll('../../assets/','./assets/')
await fs.writeFile(path.join(renderer,'index.html'),html)
for(const dir of ['bin','sidecar','fonts'])await fs.symlink(path.join(products,dir),path.join(output,dir))
const host=path.join(output,'host');await fs.mkdir(host);await fs.cp(path.join(root,'frontend/design-desktop/src'),path.join(host,'src'),{recursive:true})
await fs.symlink(path.join(root,'frontend/design-desktop/assets'),path.join(host,'assets'));await fs.symlink(output,path.join(host,'dist'))
const renderCheck=path.join(host,'src/render-check.mjs'),checkCode=await fs.readFile(renderCheck,'utf8')
assert(checkCode.includes("source: 'native-source-check.html'"));await fs.writeFile(renderCheck,checkCode.replace("source: 'native-source-check.html'","source: 'index.html'"))
const pkg=JSON.parse(await fs.readFile(path.join(root,'frontend/design-desktop/package.json'),'utf8'));pkg.main='src/main.mjs';await fs.writeFile(path.join(host,'package.json'),JSON.stringify(pkg))
assert.deepEqual(await buildInputs(root),manifest.sources,'Runtime sources drifted during lab build')
const artifacts={};for(const dir of ['bin','sidecar'])for(const name of await fs.readdir(path.join(products,dir)))artifacts[dir+'/'+name]=createHash('sha256').update(await fs.readFile(path.join(products,dir,name))).digest('hex')
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({products,host,renderer,sources:manifest.sources,artifacts},null,2))
console.log(JSON.stringify({output,host,renderer}))
