import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageSourceFilter } from '../scripts/package-source.mjs'

// Exercise the same source copy used by package.mjs without launching Electron
// or executing any replacement asset. This is not a full native bundle test.
test('fresh package source staging cannot resurrect retired sprite runtime', async () => {
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'pet-retirement-package-'))
  try {
    await cp(join(desktop, 'src'), join(temporary, 'src'), { recursive: true, filter: packageSourceFilter(join(desktop, 'src')) })
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
    assert.match(pack, /filter: packageSourceFilter\(path.join\(root, 'src'\)\)/)
    assert.doesNotMatch(build + pack, /pet\/renderer|neutral\.png|pet\/controller|pet\/preload/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('source staging excludes retired files in a reused tree and preserves current host and unrelated resources', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pet-retirement-stale-source-'))
  const source = join(temporary, 'source'), output = join(temporary, 'staged')
  try {
    const retired = ['pet/renderer/assets/neutral.png', 'pet/controller.mjs', 'pet/preload.cjs']
    const retained = ['pet/host.mjs', 'pet/companion-policy.mjs', 'other/renderer/assets/neutral.png', 'preparation-worker.mjs']
    for (const relative of [...retired, ...retained]) {
      const target = join(source, relative)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, `fixture bytes: ${relative}`)
    }
    await cp(source, output, { recursive: true, filter: packageSourceFilter(source) })
    for (const relative of ['pet/renderer', 'pet/controller.mjs', 'pet/preload.cjs'])
      await assert.rejects(stat(join(output, relative)), { code: 'ENOENT' })
    for (const relative of retained)
      assert.deepEqual(await readFile(join(output, relative)), await readFile(join(source, relative)))
    // Filtering distribution input must never remove the user's original files.
    for (const relative of retired)
      assert.equal(await readFile(join(source, relative), 'utf8'), `fixture bytes: ${relative}`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
