import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { externalFixture } from './lib/fixture-policy.mjs'

test('missing optional fixture is explicitly skipped, required mode fails', () => {
  assert.match(externalFixture('DESIGN_TEST_SKETCH', {}).skip, /not exercised/)
  assert.throws(() => externalFixture('DESIGN_TEST_SKETCH', { DESIGN_REQUIRE_PRIVATE_FIXTURES: '1' }), /not configured/)
})
test('configured missing, empty and directory inputs fail instead of becoming skip/pass', t => {
  const root = mkdtempSync(join(tmpdir(), 'design-fixture-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => externalFixture('F', { F: join(root, 'missing') }), /ENOENT/)
  assert.throws(() => externalFixture('F', { F: root }), /nonempty regular file/)
  const file = join(root, 'input'); writeFileSync(file, '')
  assert.throws(() => externalFixture('F', { F: file }), /nonempty regular file/)
  writeFileSync(file, 'input')
  assert.deepEqual(externalFixture('F', { F: file }), { path: file })
})
