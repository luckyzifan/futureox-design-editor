import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, symlink, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DirectoryGrants } from '../src/directory-grants.mjs'

test('directory grants reject traversal, symlink files and replaced roots', async () => {
  // macOS tmpdir is a /var -> /private/var symlink; resolved grant paths use it.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forma-grants-')))
  const grants = new DirectoryGrants()
  try {
    const directory = path.join(root, 'project')
    await mkdir(directory)
    await writeFile(path.join(directory, 'drawing.fd'), '{}')
    const entry = await grants.create(directory)
    entry.files.set('good', 'drawing.fd')
    entry.files.set('escape', '../outside.fd')
    assert.equal((await grants.file(entry.handle, 'good')).path, path.join(directory, 'drawing.fd'))
    await assert.rejects(grants.file(entry.handle, 'escape'), { code: 'DIRECTORY_RESELECT' })
    await symlink(path.join(directory, 'drawing.fd'), path.join(directory, 'link.fd'))
    entry.files.set('symlink', 'link.fd')
    await assert.rejects(grants.file(entry.handle, 'symlink'), { code: 'DIRECTORY_RESELECT' })
    await rename(directory, directory + '-old')
    await mkdir(directory)
    await assert.rejects(grants.lookup(entry.handle), { code: 'DIRECTORY_RESELECT' })
    assert.equal(grants.entries.size, 0)
    await rename(directory, directory + '-new')
    await rename(directory + '-old', directory)
    await assert.rejects(grants.lookup(entry.handle), { code: 'DIRECTORY_RESELECT' })
  } finally { await grants.clear(); await rm(root, { recursive: true, force: true }) }
})

test('bounded eviction protects the active root and fails explicitly without an evictable grant', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forma-protected-grant-')))
  const grants = new DirectoryGrants()
  const single = new DirectoryGrants({ limit: 1 })
  try {
    const activePath = path.join(root, 'active')
    await mkdir(activePath)
    const active = await grants.create(activePath)
    for (let index = 0; index < 20; index++) {
      const next = path.join(root, `selection-${index}`)
      await mkdir(next)
      await grants.create(next, active.handle)
      assert.ok(grants.entries.size <= 16)
    }
    assert.equal((await grants.lookup(active.handle)).path, activePath)
    const protectedEntry = await single.create(activePath)
    await assert.rejects(single.create(root, protectedEntry.handle), { code: 'DIRECTORY_LIMIT' })
    assert.equal(single.entries.size, 1)
    assert.equal((await single.lookup(protectedEntry.handle)).path, activePath)
    await rename(activePath, activePath + '-old')
    await mkdir(activePath)
    await assert.rejects(grants.lookup(active.handle), { code: 'DIRECTORY_RESELECT' })
  } finally {
    await grants.clear()
    await single.clear()
    await rm(root, { recursive: true, force: true })
  }
})
