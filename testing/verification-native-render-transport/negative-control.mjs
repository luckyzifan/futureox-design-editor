import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync,cpSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
const root=new URL('../../',import.meta.url).pathname,temp=mkdtempSync(path.join(tmpdir(),'native-render-corruption-'))
const testName='exact pixels, dimensions, stats and tight owned allocation across every split'
const testArgs=['--test','--test-reporter=tap','--test-name-pattern',`^${testName}$`]
const run=file=>spawnSync(process.execPath,[...testArgs,file],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024})
const completed=result=>!result.error&&result.signal===null&&/^1\.\.1$/m.test(result.stdout)&&/^# tests 1$/m.test(result.stdout)&&/^# cancelled 0$/m.test(result.stdout)&&/^# skipped 0$/m.test(result.stdout)&&/^# todo 0$/m.test(result.stdout)
const expectedMismatch=result=>completed(result)&&result.status===1&&result.stderr===''&&result.stdout.includes(`\nnot ok 1 - ${testName}\n`)&&/^\s+failureType: 'testCodeFailure'$/m.test(result.stdout)&&/^\s+code: 'ERR_ASSERTION'$/m.test(result.stdout)&&/^\s+operator: 'deepStrictEqual'$/m.test(result.stdout)&&/^# pass 0$/m.test(result.stdout)&&/^# fail 1$/m.test(result.stdout)
try{
 // The unchanged small-frame test must succeed first. Do not run the mutated
 // 48 MiB comparison: formatting its intentionally huge diff can exhaust Node.
 const baseline=run(path.join(root,'frontend/design-desktop/test/native-render-frame.test.mjs'))
 assert.ok(completed(baseline)&&baseline.status===0&&/^# pass 1$/m.test(baseline.stdout)&&/^# fail 0$/m.test(baseline.stdout),'Unmodified byte-preservation test did not complete successfully')
 cpSync(path.join(root,'frontend/design-desktop/src/native-render-frame.mjs'),path.join(temp,'frame.mjs'))
 let source=readFileSync(path.join(temp,'frame.mjs'),'utf8');const mutationPoint='result.rgba = rgba'
 assert.equal(source.split(mutationPoint).length,2,'Expected exactly one production pixel assignment')
 source=source.replace(mutationPoint,'rgba[rgba.length - 1] ^= 1; result.rgba = rgba');writeFileSync(path.join(temp,'frame.mjs'),source)
 const test=readFileSync(path.join(root,'frontend/design-desktop/test/native-render-frame.test.mjs'),'utf8').replaceAll('../src/native-render-frame.mjs','./frame.mjs');writeFileSync(path.join(temp,'frame.test.mjs'),test)
 const result=run(path.join(temp,'frame.test.mjs'));process.stdout.write(result.stdout+result.stderr)
 assert.ok(expectedMismatch(result),'Expected named pixel assertion mismatch; crash, timeout, setup failure and unrelated test failure are not success')
 // Real infrastructure-failure controls must not be accepted as corruption.
 const infrastructure=path.join(temp,'infrastructure.test.mjs')
 writeFileSync(infrastructure,`import test from 'node:test';test(${JSON.stringify(testName)},()=>{console.log('fail');process.exit(37)});\n`)
 const failedRun=run(infrastructure);assert.notEqual(failedRun.status,0);assert.equal(expectedMismatch(failedRun),false,'Infrastructure exit was incorrectly accepted')
 const timeout=spawnSync(process.execPath,['-e',"console.log('fail');setInterval(()=>{},1000)"],{encoding:'utf8',timeout:100,maxBuffer:1024})
 assert.equal(timeout.error?.code,'ETIMEDOUT');assert.equal(expectedMismatch(timeout),false,'Timeout was incorrectly accepted')
 console.log('PASS: unmodified small-frame test passed; the mutated production byte caused the named assertion failure with normal completion')
 console.log('PASS: real infrastructure exit and timeout were rejected by the negative-control classifier')
}finally{rmSync(temp,{recursive:true,force:true})}
