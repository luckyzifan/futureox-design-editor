/** Command Bar usage order. Session state only; it never enters the document,
 * history or save payload. Local storage is best-effort so private windows and
 * tests keep working when it is unavailable. */
const STORAGE_KEY = 'forma.command-bar.recent.v1'
const LIMIT = 16
let loaded = false
let recent: readonly string[] = []

function read(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, LIMIT) : []
  } catch { return [] }
}

function write(ids: readonly string[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch { /* storage is optional */ }
}

export function commandRecentIds(): readonly string[] {
  if (!loaded) { loaded = true; recent = read() }
  return recent
}

export function recordCommandSearchUse(id: string) {
  const ids = commandRecentIds()
  const next = [id, ...ids.filter(item => item !== id)].slice(0, LIMIT)
  if (next.every((value, index) => value === ids[index]) && next.length === ids.length) return
  recent = next
  write(next)
}

export function resetCommandSearchRecent() {
  loaded = true
  recent = []
  write(recent)
}

export function commandRecentRank(id: string): number {
  const index = commandRecentIds().indexOf(id)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}