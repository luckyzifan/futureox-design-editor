import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  CURRENT_WORKSPACE_SAVE_LABEL,
  REQUIRED_SNAPSHOT_IMPORTS,
  acceptanceCounts,
  isCurrentWorkspaceSaveLabel,
  snapshotImportPath,
  spawnOwned,
  stopOwnedProcess,
} from './gui-acceptance-layout.mjs'

test('the retired local save sentence is not the current workspace label', () => {
  assert.equal(isCurrentWorkspaceSaveLabel(CURRENT_WORKSPACE_SAVE_LABEL), true)
  assert.equal(isCurrentWorkspaceSaveLabel('已保存到本机'), false)
  assert.equal(isCurrentWorkspaceSaveLabel('已自动保存到工作副本 '), false)
  assert.equal(isCurrentWorkspaceSaveLabel('自动保存中…'), false)
  assert.equal(isCurrentWorkspaceSaveLabel(''), false)
})

test('an output/client snapshot does not land the desktop script import on the client scripts', () => {
  const output = '/tmp/forma-snapshot'
  const desktopScript = snapshotImportPath(output, 'client/vite.config.ts', '../design-desktop/scripts/render-diagnostic-build.mjs')
  assert.equal(desktopScript, path.resolve(output, 'design-desktop/scripts/render-diagnostic-build.mjs'))
  const productionPublic = snapshotImportPath(output, 'design-desktop/scripts/render-diagnostic-build.mjs', '../../design-client/scripts/production-public.mjs')
  assert.equal(productionPublic, path.resolve(output, 'design-client/scripts/production-public.mjs'))
  assert.notEqual(productionPublic, path.resolve(output, 'client/scripts/production-public.mjs'))
})

test('the repository-relative snapshot resolves config, plugin, MCP and shader imports', () => {
  const output = '/tmp/forma-snapshot'
  const expected = {
    '../design-desktop/scripts/render-diagnostic-build.mjs': 'frontend/design-desktop/scripts/render-diagnostic-build.mjs',
    './scripts/production-public.mjs': 'frontend/design-client/scripts/production-public.mjs',
    '../../design-client/scripts/production-public.mjs': 'frontend/design-client/scripts/production-public.mjs',
    '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl': 'design-studio/crates/design-kernel/shaders/vector.wgsl',
    '../../../design-mcp/src/operation-backend.mjs': 'frontend/design-mcp/src/operation-backend.mjs',
    '../../plugins/labeled-rectangles/code.js': 'frontend/design-client/plugins/labeled-rectangles/code.js',
    '../../../design-desktop/src/render-runtime-configuration.mjs': 'frontend/design-desktop/src/render-runtime-configuration.mjs',
  }
  assert.equal(REQUIRED_SNAPSHOT_IMPORTS.length, Object.keys(expected).length)
  for (const item of REQUIRED_SNAPSHOT_IMPORTS) {
    assert.equal(snapshotImportPath(output, item.from, item.specifier), path.resolve(output, expected[item.specifier]))
  }
})

test('acceptance counts keep an entry failure and a skipped check distinct', () => {
  assert.deepEqual(acceptanceCounts('check-toolbar-menu', [], new Error('save-status timeout'), false), {
    command: 'check-toolbar-menu',
    entered: false,
    executed: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    error: 'Error: save-status timeout',
  })
  assert.deepEqual(acceptanceCounts('check-panels', [
    { status: 'passed' },
    { status: 'failed' },
    { status: 'skipped' },
  ], undefined, true), {
    command: 'check-panels',
    entered: true,
    executed: 3,
    passed: 1,
    failed: 1,
    skipped: 1,
  })
})

test('stopOwnedProcess kills the owned group and leaves a sibling alive', async () => {
  const owned = spawnOwned('sleep', ['30'], { stdio: 'ignore' })
  const sibling = spawnOwned('sleep', ['30'], { stdio: 'ignore' })
  try {
    await stopOwnedProcess(owned)
    assert.throws(() => process.kill(owned.pid, 0))
    assert.doesNotThrow(() => process.kill(sibling.pid, 0))
  } finally {
    await stopOwnedProcess(sibling)
  }
  assert.throws(() => process.kill(sibling.pid, 0))
})
