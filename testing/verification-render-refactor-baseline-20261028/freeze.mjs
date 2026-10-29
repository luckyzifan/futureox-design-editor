import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'

const root=process.cwd(), output=path.resolve(process.argv[2]||''), fixture=path.resolve(process.argv[3]||'')
if(process.argv.length!==4)throw Error('Usage: node freeze.mjs FRESH_DIRECTORY SOURCE.sketch')
await fs.mkdir(output)
const sources=await buildInputs(root), snapshot=path.join(output,'source')
await fs.mkdir(snapshot)
for(const name of Object.keys(sources)){
 const to=path.join(snapshot,name);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(path.join(root,name),to)
}
// Include workspace members, compiler assets, test oracles and the validation
// entry. Never copy user documents, profiles, build outputs or dependencies.
for(const name of ['design-studio/crates','design-studio/scripts','testing/fixtures','frontend/design-client/scripts','frontend/design-client/verification/bounded-pipeline','frontend/design-mcp/src']){
 await fs.cp(path.join(root,name),path.join(snapshot,name),{recursive:true})
}
const suite='testing/verification-render-refactor-baseline-20261028'
await fs.mkdir(path.join(snapshot,suite),{recursive:true})
// A second run must not copy prior private screenshots, reports or profiles.
for(const entry of await fs.readdir(path.join(root,suite),{withFileTypes:true})) {
 if(entry.isFile()&&(/\.(mjs|tsx|html|md)$/.test(entry.name)||entry.name==='fixture.json'))
  await fs.copyFile(path.join(root,suite,entry.name),path.join(snapshot,suite,entry.name))
}
for(const name of ['frontend/design-client','frontend/design-desktop'])await fs.symlink(path.join(root,name,'node_modules'),path.join(snapshot,name,'node_modules'))
await fs.copyFile(path.join(root,'frontend/design-mcp/package.json'),path.join(snapshot,'frontend/design-mcp/package.json'))
await fs.copyFile(path.join(root,'frontend/design-client/vitest.config.ts'),path.join(snapshot,'frontend/design-client/vitest.config.ts'))
await fs.symlink(path.join(root,'frontend/design-client/node_modules'),path.join(snapshot,'node_modules'))
if(JSON.stringify(await buildInputs(root))!==JSON.stringify(sources)||JSON.stringify(await buildInputs(snapshot))!==JSON.stringify(sources))throw Error('Source drift while freezing; do not use this snapshot')
const bytes=await fs.readFile(fixture), sha=v=>createHash('sha256').update(v).digest('hex')
const record={format:1,createdAt:new Date().toISOString(),root,snapshot,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 sourceDigest:sha(JSON.stringify(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b)))),sources,
 fixture:{path:fixture,bytes:bytes.length,sha256:sha(bytes)},scope:'Frozen dirty workspace; generated bindings rebuilt separately; source file is read only'}
await fs.writeFile(path.join(output,'baseline.json'),JSON.stringify(record,null,2))
// Keep every baseline inside its unique run directory; historical records are immutable.
console.log(JSON.stringify({output,snapshot,sourceDigest:record.sourceDigest,fixture:record.fixture}))
