import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
const root=await mkdtemp(path.join(tmpdir(),'preparation-poison-negative-'))
try{
 const source=await readFile(new URL('../../frontend/design-desktop/src/preparation-frame.mjs',import.meta.url),'utf8')
 const original='copyRange(this.parts,12+this.expected.metadata,bytes)'
 assert.equal(source.split(original).length,2)
 await writeFile(path.join(root,'preparation-frame.mjs'),source.replace(original,original+'\n   if(bytes.length)bytes[bytes.length-1]=0xa5'))
 const tests=await readFile(new URL('../../frontend/design-desktop/test/preparation-frame.test.mjs',import.meta.url),'utf8')
 await writeFile(path.join(root,'negative.test.mjs'),tests.replaceAll("'../src/preparation-frame.mjs'","'./preparation-frame.mjs'"))
 const result=spawnSync(process.execPath,['--test','--test-name-pattern','preserves every binary byte',path.join(root,'negative.test.mjs')],{encoding:'utf8',timeout:30000})
 process.stdout.write(result.stdout);process.stderr.write(result.stderr)
 assert.equal(result.status,1,result.error?.message)
 assert.match(result.stdout,/AssertionError/)
 assert.match(result.stdout,/fail 1/)
 console.log('Expected negative-control failure confirmed: a corrupted payload byte is detected.')
}finally{await rm(root,{recursive:true,force:true})}
