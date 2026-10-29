import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {renderCheckHandler} from '../../frontend/design-desktop/src/render-check.mjs'
import {imageName} from './report-contract.mjs'
test('both evidence stages use the actual host image contract',async t=>{
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'render-evidence-'))
  t.after(()=>fs.rm(out,{recursive:true,force:true}))
  const handle=renderCheckHandler({},out,()=>({}))
  const png=Buffer.from([137,80,78,71,13,10,26,10])
  for(const stage of ['ready','quiet']) {
    const name=imageName(3,stage)
    const reply=await handle(new Request(`design-app://app/__precision_image?name=${name}`,{method:'POST',body:png}))
    assert.equal(reply?.status,200)
    assert.deepEqual(await fs.readFile(path.join(out,`${name}.png`)),png)
  }
  assert.equal(await handle(new Request('design-app://app/__precision_image?name=pose-3-ready',{method:'POST',body:png})),undefined)
  assert.throws(()=>imageName(-1,'ready'),/Invalid/)
})
