import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, open, stat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installSidecar } from '../scripts/install-sidecar.mjs'

test('installing a sidecar replaces its inode and preserves an existing open executable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forma-install-'))
  const source = path.join(root, 'source'), target = path.join(root, 'backend')
  let old
  try {
    await writeFile(source, 'new executable'); await writeFile(target, 'running executable')
    const before = await stat(target); old = await open(target, 'r')
    await installSidecar(source, target)
    assert.equal(await readFile(target, 'utf8'), 'new executable')
    assert.equal(await old.readFile('utf8'), 'running executable')
    if (process.platform !== 'win32') {
      assert.notEqual((await stat(target)).ino, before.ino)
      assert.equal((await stat(target)).mode & 0o777, 0o755)
    }
    assert.deepEqual((await readdir(root)).sort(), ['backend', 'source'])
  } finally { await old?.close(); await rm(root, { recursive: true, force: true }) }
})
