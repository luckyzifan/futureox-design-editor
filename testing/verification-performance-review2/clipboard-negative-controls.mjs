/** Isolated bad-code controls. Never swaps or writes production files. */
import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const evidence=dirname(fileURLToPath(import.meta.url)),root=resolve(evidence,'../..'),client=join(root,'frontend/design-client'),src=join(client,'src')
const temporary=mkdtempSync(join(tmpdir(),'design-review-negative-'))
const dependencies=realpathSync(join(client,'node_modules'))
const clean=s=>s.replaceAll(root,'<repository>').replaceAll(temporary,'<isolated-negative-control>').replaceAll(dependencies,'<installed-dependencies>')
const controls=[
 {name:'mask-guard',source:'paste-over-selection.ts',test:'paste-mask-isolation.test.tsx',line:"  if (roots.some(id => source.nodes[id].mask)) throw Error('覆盖粘贴独立蒙版会改变目标容器的蒙版范围；请先将蒙版与内容编组后复制')",module:'paste-over-selection',failed:2,passed:2,pattern:/to throw an error|did not throw|toThrow/i},
 {name:'font-restore',source:'editor-commands.ts',test:'paste-postlayout-fonts.test.tsx',line:'        finally { activateDocumentFonts(editor.state.doc) }',replacement:'        finally { /* deliberately omitted restoration */ }',module:'editor-commands',failed:1,passed:1,pattern:/deeply equal|toEqual/},
]
try {
 for(const c of controls){
  const source=readFileSync(join(src,c.source),'utf8');assert.ok(source.includes(c.line),`Mutation anchor ${c.name}`)
  const mutant=join(temporary,c.source)
  writeFileSync(mutant,source.replace(c.line,c.replacement??'').replace(/(['"])\.\//g,`$1${src}/`))
  const test=readFileSync(join(evidence,c.test),'utf8').replaceAll('../../frontend/design-client/src/',`${src}/`).replaceAll('../../frontend/design-client/public/',`${client}/public/`).replace(`${src}/${c.module}'`,`${mutant}'`)
  const testPath=join(temporary,c.test);writeFileSync(testPath,test)
  const config=join(temporary,`${c.name}.config.mjs`)
  writeFileSync(config,`export default ${JSON.stringify({root:client,resolve:{alias:{'react-dom/client':join(client,'node_modules/react-dom/client.js'),react:join(client,'node_modules/react'),jsdom:join(client,'node_modules/jsdom/lib/api.js')}},test:{setupFiles:[join(src,'test-setup.ts')],include:[testPath],maxWorkers:1}})}`)
  const json=join(temporary,`${c.name}.json`)
  const result=spawnSync(process.execPath,[join(client,'node_modules/vitest/vitest.mjs'),'run','--config',config,'--reporter=json',`--outputFile=${json}`],{cwd:root,encoding:'utf8',timeout:90000})
  assert.equal(result.status,1,`${c.name}: expected actual assertion failure; ${result.stdout}${result.stderr}`)
  const report=JSON.parse(readFileSync(json,'utf8'))
  assert.equal(report.numFailedTests,c.failed);assert.equal(report.numPassedTests,c.passed)
  const failures=report.testResults.flatMap(f=>f.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})))
  assert.ok(failures.every(f=>c.pattern.test(f.messages.join('\n'))),JSON.stringify(failures))
  writeFileSync(join(evidence,`negative-${c.name}.json`),clean(JSON.stringify({status:'expected assertion failures detected',failed:c.failed,passed:c.passed,failures},null,2))+'\n')
  console.log(`${c.name}: ${c.failed} expected assertion failures, ${c.passed} remaining tests passed`)
 }
} finally {rmSync(temporary,{recursive:true,force:true})}
