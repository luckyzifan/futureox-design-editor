import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
const [oldBase,newBase]=process.argv.slice(2).map(p=>path.resolve(p))
if(!oldBase||!newBase)throw Error('Usage: node reuse-native.mjs OLD_FROZEN_BASE NEW_FROZEN_BASE')
const old=JSON.parse(await fs.readFile(path.join(oldBase,'baseline.json'),'utf8')),next=JSON.parse(await fs.readFile(path.join(newBase,'baseline.json'),'utf8'))
const changed=[...new Set([...Object.keys(old.sources),...Object.keys(next.sources)])].filter(k=>old.sources[k]!==next.sources[k])
if(changed.some(k=>!k.startsWith('frontend/design-client/src/')))throw Error('Native/build/public input changed: rebuild instead of reusing')
const artifacts={};for(const rel of ['bin/design-prepare','bin/design-render','sidecar/futureox-design-desktop-backend']){
 const oldFile=path.join(oldBase,'products',rel),to=path.join(newBase,'products',rel);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(oldFile,to);await fs.chmod(to,0o755)
 artifacts[rel]=createHash('sha256').update(await fs.readFile(to)).digest('hex')
}
await fs.cp(path.join(oldBase,'products/fonts'),path.join(newBase,'products/fonts'),{recursive:true})
for(const rel of ['frontend/design-client/src/generated/design-kernel','frontend/design-client/public/kernel'])await fs.cp(path.join(old.snapshot,rel),path.join(next.snapshot,rel),{recursive:true})
artifacts.wasm=createHash('sha256').update(await fs.readFile(path.join(next.snapshot,'frontend/design-client/public/kernel/design_kernel_bg.wasm'))).digest('hex')
await fs.writeFile(path.join(newBase,'native-reuse.json'),JSON.stringify({oldBase,newBase,unchangedNativeBuildInputs:true,changedClientInputs:changed,artifacts,note:'Exact native/Rust/shader/toolchain inputs match the preceding rebuilt baseline; only frontend sources changed'},null,2))
console.log(JSON.stringify({changedClientInputs:changed,artifacts}))
