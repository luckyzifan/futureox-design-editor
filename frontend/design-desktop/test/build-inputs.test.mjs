import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildInputs, buildProfile, BUILD_DIRECTORIES, BUILD_FILES } from '../scripts/build-inputs.mjs'

test('local desktop defaults to optimized native products and records GPU sources', () => {
  assert.equal(buildProfile([]), 'release')
  assert.equal(buildProfile(['--release']), 'release')
  assert.equal(buildProfile(['--debug']), 'debug')
  assert.throws(() => buildProfile(['--debug', '--release']), /Choose/)
  assert.ok(BUILD_DIRECTORIES.includes('design-studio/crates/design-gpu/src'))
  assert.ok(BUILD_FILES.includes('design-studio/crates/design-gpu/Cargo.toml'))
})

test('build provenance detects edited/deleted inputs while generated artifacts do not self-invalidate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forma-build-inputs-'))
  try {
    for (const directory of BUILD_DIRECTORIES)
      await mkdir(path.join(root, directory), { recursive: true })
    for (const name of BUILD_FILES) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await writeFile(path.join(root, name), 'original')
    }
    const source = 'frontend/design-client/src/editor.ts'
    await writeFile(path.join(root, source), 'original')
    const baseline = await buildInputs(root)
    assert.match(baseline[source], /^[0-9a-f]{64}$/)
    for (const directory of [
      'frontend/design-client/src/generated',
      'frontend/design-client/public/kernel',
    ]) {
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, 'kernel.wasm'), 'generated')
    }
    assert.deepEqual(await buildInputs(root), baseline)
    await writeFile(path.join(root, source), 'changed')
    assert.notDeepEqual(await buildInputs(root), baseline)
    await rm(path.join(root, source))
    assert.notDeepEqual(await buildInputs(root), baseline)
    await rm(path.join(root, BUILD_FILES[0]))
    await assert.rejects(buildInputs(root), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('build provenance detects vendored compiler source and manifest changes, excluding unrelated vendor files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forma-vendor-inputs-'))
  try {
    for (const directory of BUILD_DIRECTORIES)
      await mkdir(path.join(root, directory), { recursive: true })
    for (const name of BUILD_FILES) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await writeFile(path.join(root, name), 'original')
    }
    const source = path.join(root, 'vendor/moxcms/src/lib.rs')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'original')
    const baseline = await buildInputs(root)
    assert.match(baseline['vendor/moxcms/src/lib.rs'] || '', /^[0-9a-f]{64}$/)
    for (const directory of ['vendor/moxcms/target', 'vendor/moxcms/.git']) {
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, 'unrelated'), 'ignored')
    }
    assert.deepEqual(await buildInputs(root), baseline)
    await writeFile(source, 'changed')
    assert.notDeepEqual(await buildInputs(root), baseline)
    await writeFile(source, 'original')
    await writeFile(path.join(root, 'vendor/moxcms/Cargo.toml'), 'changed manifest')
    assert.notDeepEqual(await buildInputs(root), baseline)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
