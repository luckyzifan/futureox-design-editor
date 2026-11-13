import test from 'node:test'
import assert from 'node:assert/strict'
import { verifySameTargetPackagedMcp } from '../scripts/verify-packaged-mcp-path.mjs'

test('same-target packaged Electron runs both MCP entries through a symlink', { timeout: 180000 }, async () => {
  const report = await verifySameTargetPackagedMcp()
  assert.equal(report.sameTarget, true)
  assert.equal(report.devDirectoryCli, false)
  assert.equal(report.toolsListAlone, false)
  assert.equal(report.envReplaced, true)
  assert.equal(report.launchedThroughSymlink, true)
  assert.equal(report.externalClientAcceptance, false)
  assert.equal(report.editorGui, 'not_run')
  assert.equal(report.signedInstaller, 'not_run')
  assert.match(report.electron, /^\d+\.\d+\.\d+$/)
  for (const step of report.steps) assert.equal(step.status, 'passed', `${step.entry} ${step.id}`)
  for (const id of ['handshake', 'read', 'edit', 'screenshot', 'undo', 'revoke_rejects_old_resource']) {
    assert.ok(report.steps.some(step => step.entry === 'cli.mjs' && step.id === id), id)
  }
  for (const id of ['handshake', 'read', 'edit', 'screenshot', 'revoke_rejects_old_resource']) {
    assert.ok(report.steps.some(step => step.entry === 'figma-cli.mjs' && step.id === id), id)
  }
  assert.ok(report.steps.some(step => step.id === 'undo' && step.entry === 'cli.mjs-after-figma-edit'))
  assert.equal(report.externalClientSteps.every(step => step.status === 'not_run'), true)
  assert.equal(report.clients.every(client => client.status !== 'passed'), true)
  assert.equal(JSON.stringify(report).includes('FUTUREOX_DESIGN_BRIDGE_TOKEN'), false)
})
