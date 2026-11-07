import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertIndependentExport } from '../src/independent-export.mjs'

test('input files are protected across direct paths, symlinks and hard links; independent exports remain available',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'futureox-independent-'))
  try {
    const original=path.join(dir,'original.sketch'),symbolic=path.join(dir,'alias.sketch'),hard=path.join(dir,'hard.sketch')
    await writeFile(original,'immutable source bytes')
    await symlink(original,symbolic);await link(original,hard)
    for(const output of [original,path.join(dir,'nested','..','original.sketch'),symbolic,hard])
      await assert.rejects(()=>assertIndependentExport(output,original),/原文件保持不变/)
    await assertIndependentExport(path.join(dir,'copy.sketch'),original)
    await writeFile(path.join(dir,'existing-copy.sketch'),'previous export')
    await assertIndependentExport(path.join(dir,'existing-copy.sketch'),original)
    assert.equal(await readFile(original,'utf8'),'immutable source bytes')
  } finally { await rm(dir,{recursive:true,force:true}) }
})
