import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {verifyArtifacts} from './provenance.mjs'
test('only exact built artifacts can supply a baseline',async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'render-baseline-proof-'))
  t.after(()=>fs.rm(base,{recursive:true,force:true}))
  const bundle=path.join(base,'v1');await fs.mkdir(bundle)
  const file=path.join(bundle,'entry.js');await fs.writeFile(file,'first')
  const manifest={artifacts:{'entry.js':createHash('sha256').update('first').digest('hex')}}
  assert.deepEqual(await verifyArtifacts(base,bundle,manifest),{checked:1,matched:true})
  await fs.writeFile(file,'changed')
  await assert.rejects(verifyArtifacts(base,bundle,manifest),/Artifact drift/)
  await assert.rejects(verifyArtifacts(base,bundle,{artifacts:{'../entry.js':'x'}}),/Unsafe/)
  await assert.rejects(verifyArtifacts(base,bundle,{artifacts:{}}),/Missing/)
})
