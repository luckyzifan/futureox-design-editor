import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the same source copy used by package.mjs without launching Electron
// or executing any replacement asset. This is not a full native bundle test.
test('fresh package source staging cannot resurrect retired sprite runtime', async () => {
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'pet-retirement-package-'))
  try {
    await cp(join(desktop, 'src'), join(temporary, 'src'), { recursive: true })
    for (const path of ['pet/renderer', 'pet/controller.mjs', 'pet/preload.cjs'])
      await assert.rejects(stat(join(temporary, 'src', path)), { code: 'ENOENT' })
    const names = await readdir(join(temporary, 'src/pet'))
    assert.deepEqual(names.sort(), ['companion-policy.mjs', 'host.mjs'])
    const host = await readFile(join(temporary, 'src/pet/host.mjs'), 'utf8')
    assert.match(host, /replacement-verification-pending/)
    assert.doesNotMatch(host, /BrowserWindow|neutral\.png|loadURL|loadFile/)
    const build = await readFile(join(desktop, 'scripts/build.mjs'), 'utf8')
    const pack = await readFile(join(desktop, 'scripts/package.mjs'), 'utf8')
    assert.match(build, /--emptyOutDir/)
    assert.match(pack, /await rm\(staging, \{ recursive: true, force: true \}\)/)
    assert.match(pack, /await cp\(path.join\(root, 'src'\), path.join\(staging, 'src'\)/)
    assert.doesNotMatch(build + pack, /pet\/renderer|neutral\.png|pet\/controller|pet\/preload/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
