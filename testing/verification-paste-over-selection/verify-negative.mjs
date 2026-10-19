// Isolated old-code behavior control. Never overwrites working-tree sources.
import { cp, mkdtemp, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..'),client=path.join(repo,'frontend/design-client')
const temp=await mkdtemp(path.join(os.tmpdir(),'canvas-workflow-negative-')),dest=path.join(temp,'frontend/design-client')
await cp(client+'/src',dest+'/src',{recursive:true})
for(const file of ['package.json','vitest.config.ts'])await cp(client+'/'+file,dest+'/'+file)
await symlink(client+'/node_modules',dest+'/node_modules','dir');await symlink(client+'/public',dest+'/public','dir')
await symlink(path.join(repo,'frontend/design-desktop'),path.join(temp,'frontend/design-desktop'),'dir')
for(const file of ['editor-commands.ts','editor-shortcuts.ts','shortcut-profiles.ts'])await cp(path.join(here,'before',file),path.join(dest,'src',file))
const output=path.join(temp,'negative-results.json')
const run=spawnSync(process.execPath,[path.join(client,'node_modules/vitest/vitest.mjs'),'run','src/canvas-workflow-shortcuts.test.ts','src/paste-over-selection.test.ts','-t','small/large all-direction|single target retains|Sketch per-target|Sketch selects eligible','--reporter=json','--outputFile='+output],{cwd:dest,encoding:'utf8'})
const result=JSON.parse(await readFile(output,'utf8')),failed=result.testResults.flatMap(s=>s.assertionResults).filter(t=>t.status==='failed')
if(run.status!==1 || failed.length!==9 || failed.some(t=>!t.failureMessages.some(m=>m.includes('AssertionError'))))throw Error('Old-code control did not produce the nine expected behavioral assertion failures: '+run.stdout+run.stderr)
console.log(JSON.stringify({expectedFailures:failed.length,failures:failed.map(t=>({name:t.fullName,message:t.failureMessages[0].split('\n')[0]})),evidence:output},null,2))
