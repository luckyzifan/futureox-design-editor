import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const root = new URL('../../../', import.meta.url)
const json = async relative => JSON.parse(await readFile(new URL(relative, root), 'utf8'))
test('React notice versions agree with exact manifest, lock, inventory and installed packages', async () => {
  const manifest = await json('frontend/design-client/package.json')
  const lock = JSON.parse((await readFile(new URL('frontend/design-client/bun.lock', root), 'utf8')).replace(/,\s*([}\]])/g, '$1'))
  const inventory = await json('frontend/design-client/public/licenses/inventory.json')
  const notices = await readFile(new URL('THIRD_PARTY_NOTICES.md', root), 'utf8')
  for (const name of ['react', 'react-dom']) {
    const version = manifest.dependencies[name]
    assert.match(version, /^\d+\.\d+\.\d+$/)
    assert.equal(lock.workspaces[''].dependencies[name], version)
    assert.equal(lock.packages[name][0], `${name}@${version}`)
    assert.equal((await json(`frontend/design-client/node_modules/${name}/package.json`)).version, version)
    assert.equal(inventory.packages.find(item => item.package === name).version, version)
    assert.ok(notices.includes(`- ${name} ${version}: MIT;`), `Refresh top-level notice for ${name}`)
  }
})
