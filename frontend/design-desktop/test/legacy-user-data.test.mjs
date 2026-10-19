import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  LEGACY_MIGRATION_MARKER,
  planLegacyUserDataMigration,
  runLegacyUserDataMigration,
} from '../src/legacy-user-data.mjs'

// macOS tmpdir is a /private symlink; the appData/userData pair uses real paths.
function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forma-legacy-'))
  return { root, appData: path.join(root, 'Application Support'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function legacyProfile(appData, name, { workspace = true, catalog = true, wal = false, recovery = false, windowState = false, caches = false, mtime } = {}) {
  const dir = path.join(appData, name)
  mkdirSync(dir, { recursive: true })
  const touch = (file, content) => {
    writeFileSync(file, content)
    if (mtime) utimesSync(file, mtime, mtime)
  }
  if (workspace) touch(path.join(dir, 'workspace-v1.sqlite3'), `ws:${name}`)
  if (wal) touch(path.join(dir, 'workspace-v1.sqlite3-wal'), `wal:${name}`)
  if (catalog) touch(path.join(dir, 'catalog-v1.sqlite3'), `cat:${name}`)
  if (recovery) {
    mkdirSync(path.join(dir, 'recovery-v1'))
    touch(path.join(dir, 'recovery-v1', 'r1.json'), '{}')
  }
  if (windowState) touch(path.join(dir, 'window-state-v1.json'), '{}')
  if (caches) {
    mkdirSync(path.join(dir, 'GPUPersistentCache'))
    touch(path.join(dir, 'Local State'), '{}')
  }
  return dir
}

test('first run under the new name carries durable stores forward and leaves caches behind', () => {
  const { appData, cleanup } = sandbox()
  try {
    const source = legacyProfile(appData, 'Forma Local', { wal: true, recovery: true, windowState: true, caches: true })
    const userData = path.join(appData, 'futureox-desgin')
    const result = runLegacyUserDataMigration(planLegacyUserDataMigration({ appData, userData }))
    assert.ok(result, 'a legacy profile with durable stores must migrate')
    assert.equal(result.source, source)
    assert.deepEqual(result.copied.sort(), [
      'catalog-v1.sqlite3',
      'recovery-v1',
      'window-state-v1.json',
      'workspace-v1.sqlite3',
      'workspace-v1.sqlite3-wal',
    ])
    assert.equal(readFileSync(path.join(userData, 'workspace-v1.sqlite3'), 'utf8'), 'ws:Forma Local')
    assert.ok(existsSync(path.join(userData, 'recovery-v1', 'r1.json')))
    assert.ok(!existsSync(path.join(userData, 'GPUPersistentCache')), 'caches must not follow the rename')
    assert.ok(!existsSync(path.join(userData, 'Local State')), 'electron session state must not follow the rename')
    assert.ok(existsSync(path.join(userData, LEGACY_MIGRATION_MARKER)))
    assert.equal(
      planLegacyUserDataMigration({ appData, userData }),
      null,
      'the marker makes migration one-shot',
    )
    // The old profile is copied, never deleted.
    assert.ok(existsSync(path.join(source, 'workspace-v1.sqlite3')))
  } finally {
    cleanup()
  }
})

test('a live database in the new profile is never joined by a foreign WAL', () => {
  const { appData, cleanup } = sandbox()
  try {
    legacyProfile(appData, 'Forma', { wal: true, catalog: false })
    const userData = path.join(appData, 'futureox-desgin')
    mkdirSync(userData, { recursive: true })
    writeFileSync(path.join(userData, 'workspace-v1.sqlite3'), 'new-profile')
    const result = runLegacyUserDataMigration(planLegacyUserDataMigration({ appData, userData }))
    assert.equal(result, null, 'nothing durable is missing, so nothing migrates')
    assert.equal(readFileSync(path.join(userData, 'workspace-v1.sqlite3'), 'utf8'), 'new-profile')
    assert.ok(!existsSync(path.join(userData, 'workspace-v1.sqlite3-wal')), 'a WAL from another profile must never land beside a foreign database')
  } finally {
    cleanup()
  }
})

test('the most recently active legacy profile wins when several exist', () => {
  const { appData, cleanup } = sandbox()
  try {
    legacyProfile(appData, 'Forma', { mtime: new Date('2026-10-08T00:00:00Z') })
    const newest = legacyProfile(appData, 'Forma Local', { mtime: new Date('2026-10-12T00:00:00Z') })
    const userData = path.join(appData, 'futureox-desgin')
    const result = runLegacyUserDataMigration(planLegacyUserDataMigration({ appData, userData }))
    assert.equal(result.source, newest)
    assert.equal(readFileSync(path.join(userData, 'workspace-v1.sqlite3'), 'utf8'), 'ws:Forma Local')
  } finally {
    cleanup()
  }
})

test('profiles without durable stores, markers in the target, and missing sources plan nothing', () => {
  const { appData, cleanup } = sandbox()
  try {
    legacyProfile(appData, 'Forma', { workspace: false, catalog: false, caches: true })
    const userData = path.join(appData, 'futureox-desgin')
    assert.equal(planLegacyUserDataMigration({ appData, userData }), null)
    mkdirSync(userData, { recursive: true })
    writeFileSync(path.join(userData, LEGACY_MIGRATION_MARKER), '{}')
    legacyProfile(appData, 'Forma Local')
    assert.equal(planLegacyUserDataMigration({ appData, userData }), null, 'a completed migration never re-runs')
    assert.equal(planLegacyUserDataMigration({ appData: userData, userData }), null)
  } finally {
    cleanup()
  }
})
