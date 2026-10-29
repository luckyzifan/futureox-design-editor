import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const [work,products,run]=process.argv.slice(2)
if(![work,products,run].every(p=>p&&path.isAbsolute(p)))throw Error('Absolute source, coherent products and fresh run required')
const root=process.cwd(),snapshot=path.join(run,'source'),inputs=await buildInputs(work)
const product=JSON.parse(await fs.readFile(path.join(products,'build-manifest.json'),'utf8'))
if(JSON.stringify(product.sources)!==JSON.stringify(inputs))throw Error('Product/source mismatch')
await fs.mkdir(run);await fs.mkdir(snapshot)
for(const rel of Object.keys(inputs)){
 await fs.mkdir(path.dirname(path.join(snapshot,rel)),{recursive:true})
 await fs.copyFile(path.join(work,rel),path.join(snapshot,rel))
}
for(const rel of ['frontend/design-client/src/generated','frontend/design-client/public/kernel'])
 await fs.cp(path.join(work,rel),path.join(snapshot,rel),{recursive:true})
for(const [dest,src]of [['node_modules','frontend/design-client/node_modules'],['frontend/design-client/node_modules','frontend/design-client/node_modules'],['frontend/design-desktop/node_modules','frontend/design-desktop/node_modules']])
 await fs.symlink(path.join(root,src),path.join(snapshot,dest))
await fs.symlink(products,path.join(run,'products'))
const record='testing/verification-sharp-refactor-20261029'
await fs.mkdir(path.join(snapshot,record),{recursive:true})
const baseline=JSON.parse(await fs.readFile(path.join(root,record,'baseline.json'),'utf8'))
Object.assign(baseline,{snapshot,sources:inputs,createdAt:new Date().toISOString(),
 sourceDigest:createHash('sha256').update(JSON.stringify(Object.entries(inputs).sort(([a],[b])=>a.localeCompare(b)))).digest('hex')})
await fs.writeFile(path.join(run,'baseline.json'),JSON.stringify(baseline,null,2))
if(JSON.stringify(await buildInputs(snapshot))!==JSON.stringify(inputs))throw Error('Frozen inputs mismatch')
console.log(JSON.stringify({run,sourceDigest:baseline.sourceDigest}))
