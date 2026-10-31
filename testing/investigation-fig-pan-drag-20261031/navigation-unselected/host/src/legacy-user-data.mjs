import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The desktop app was renamed in 3917bba91 (2026-10-13): Forma* →
// futureox-desgin*. Electron homes every durable store (catalog/workspace
// sqlite, recovery, window state) under appData/<productName>, so the rename
// stranded older profiles with no code path that could read them again. On the
// first run under the new name the durable document stores are carried forward
// from the most recent legacy profile. Old profiles are copied, never deleted,
// and disposable caches/session state stay behind: they are profile-bound.
export const LEGACY_PRODUCT_NAMES = ['Forma Local', 'Forma', 'Forma Preview', 'Forma Exact']
export const LEGACY_MIGRATION_MARKER = 'legacy-migration-v1.json'

const DB_STEMS = ['catalog-v1', 'workspace-v1']
const SQLITE_SIDECARS = ['sqlite3-wal', 'sqlite3-shm']

function durableMtime(dir) {
  let latest = -Infinity
  let durable = false
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    const stem = DB_STEMS.find(
      (candidate) => name === `${candidate}.sqlite3` ||
        SQLITE_SIDECARS.some((side) => name === `${candidate}.${side}`),
    )
    if (stem || name === 'window-state-v1.json') {
      durable = true
      latest = Math.max(latest, statSync(file).mtimeMs)
    } else if (name === 'recovery-v1') {
      // The newest recovery write proxies for profile activity; an unreadable
      // recovery directory cannot disqualify the databases beside it.
      try {
        for (const child of readdirSync(file)) {
          durable = true
          latest = Math.max(latest, statSync(path.join(file, child)).mtimeMs)
        }
      } catch {
        /* keep whatever the databases alone prove */
      }
    }
  }
  return durable ? latest : -Infinity
}

/** Plan the one-shot forward migration. Returns null when there is nothing to
 * do: the marker already ran, no legacy profile exists, or every durable file
 * is already present in the target profile. */
export function planLegacyUserDataMigration({
  appData,
  userData,
  productNames = LEGACY_PRODUCT_NAMES,
}) {
  if (!appData || !userData || appData === userData) return null
  if (existsSync(path.join(userData, LEGACY_MIGRATION_MARKER))) return null
  const candidates = productNames
    .map((name) => path.join(appData, name))
    .filter((dir) => existsSync(dir))
    .map((dir) => ({ dir, mtime: durableMtime(dir) }))
    .filter((candidate) => candidate.mtime > -Infinity)
    .sort((a, b) => b.mtime - a.mtime)
  for (const { dir } of candidates) {
    const entries = []
    for (const stem of DB_STEMS) {
      // A database moves as one unit with its WAL siblings, and only when the
      // target lacks the main file: a stray -wal beside a foreign database
      // would feed another profile's frames to SQLite.
      if (
        !existsSync(path.join(dir, `${stem}.sqlite3`)) ||
        existsSync(path.join(userData, `${stem}.sqlite3`))
      )
        continue
      for (const name of [`${stem}.sqlite3`, ...SQLITE_SIDECARS.map((side) => `${stem}.${side}`)]) {
        const from = path.join(dir, name)
        if (existsSync(from)) entries.push({ kind: 'file', from, to: path.join(userData, name) })
      }
    }
    const recovery = path.join(dir, 'recovery-v1')
    if (existsSync(recovery) && !existsSync(path.join(userData, 'recovery-v1')))
      entries.push({ kind: 'dir', from: recovery, to: path.join(userData, 'recovery-v1') })
    const windowState = path.join(dir, 'window-state-v1.json')
    if (existsSync(windowState) && !existsSync(path.join(userData, 'window-state-v1.json')))
      entries.push({ kind: 'file', from: windowState, to: path.join(userData, 'window-state-v1.json') })
    if (entries.length)
      return { source: dir, userData, entries, marker: path.join(userData, LEGACY_MIGRATION_MARKER) }
  }
  return null
}

/** Execute a plan. Never overwrites: every destination was verified missing at
 * planning time, and the copy still refuses existing targets. */
export function runLegacyUserDataMigration(plan) {
  if (!plan) return null
  const copied = []
  for (const entry of plan.entries) {
    mkdirSync(path.dirname(entry.to), { recursive: true })
    if (entry.kind === 'dir') cpSync(entry.from, entry.to, { recursive: true, force: false })
    else copyFileSync(entry.from, entry.to)
    copied.push(path.relative(plan.userData, entry.to))
  }
  writeFileSync(
    plan.marker,
    `${JSON.stringify({ source: plan.source, copied, at: new Date().toISOString() }, null, 2)}\n`,
  )
  return { source: plan.source, copied }
}
