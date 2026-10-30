/**
 * E1 wiring check: the wasm AnimationBakeSession serves prototype playback —
 * bake once, sample many, second identical bake hits the plan cache, live
 * pairs conflict across sessions, invalid revisions are rejected.
 * Run: bun scripts/check-bake-session.ts
 */
import { readFileSync } from 'node:fs'
import initKernel, {
  AnimationBakeSession,
  animation_plan_sample_json,
} from '../src/generated/design-kernel/design_kernel'
import { blank, node } from '../src/model'

const bytes = readFileSync(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url))
const module = await WebAssembly.compile(new Uint8Array(bytes).buffer as ArrayBuffer)
await initKernel({ module_or_path: module })

const doc = blank('bake-session-check')
const page = doc.pages[0]
const oldFrame = node('frame', 0, 0, 200, 200)
oldFrame.name = 'old'
const newFrame = node('frame', 320, 0, 200, 200)
newFrame.name = 'new'
const sharedOld = node('rectangle', 10, 10, 24, 16)
sharedOld.name = 'shared'
const sharedNew = node('rectangle', 140, 90, 48, 32)
sharedNew.name = 'shared'
oldFrame.children = [sharedOld.id]
newFrame.children = [sharedNew.id]
page.children = [oldFrame.id, newFrame.id]
for (const n of [oldFrame, newFrame, sharedOld, sharedNew]) doc.nodes[n.id] = n

const json = JSON.stringify(doc)
let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok' : 'FAIL'} - ${label}`)
}

// Sampling before any bake is an error, not empty data.
const empty = new AnimationBakeSession()
try {
  empty.sample_json(0.5)
  check(false, 'sample before bake throws')
} catch {
  check(true, 'sample before bake throws')
}
empty.free()

// Bake once, sample many: identical output to the stateless sampler.
const session = new AnimationBakeSession()
session.bake(json, json, oldFrame.id, newFrame.id, 7)
for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
  const viaSession = session.sample_json(progress)
  const viaStateless = animation_plan_sample_json(json, oldFrame.id, newFrame.id, progress)
  check(viaSession === viaStateless, `sample at progress ${progress} matches the stateless path`)
  const parsed = JSON.parse(viaSession)
  check(!!parsed.nodes && !!parsed.pages, `sample at progress ${progress} is a valid document`)
}
let stats = JSON.parse(session.stats_json())
check(stats.lookups === 1 && stats.misses === 1 && stats.hits === 0, `first bake is a cold miss ${JSON.stringify(stats)}`)

// Second identical bake (the replay case): served by the warm cache.
session.bake(json, json, oldFrame.id, newFrame.id, 7)
stats = JSON.parse(session.stats_json())
check(stats.lookups === 2 && stats.hits === 1 && stats.misses === 1, `second identical bake hits the cache ${JSON.stringify(stats)}`)

// A bumped revision rebuilds instead of serving the stale slot.
session.bake(json, json, oldFrame.id, newFrame.id, 8)
stats = JSON.parse(session.stats_json())
check(stats.misses === 2, `revision bump misses and rebuilds ${JSON.stringify(stats)}`)

// Invalid revision is rejected like DocumentHistory.apply.
try {
  session.bake(json, json, oldFrame.id, newFrame.id, 1.5)
  check(false, 'fractional revision rejected')
} catch {
  check(true, 'fractional revision rejected')
}

// The shared in-flight mutex: a second live session overlapping the pair
// conflicts with the engine's structured error shape (kind/tag/pairs).
const other = new AnimationBakeSession()
try {
  other.bake(json, json, oldFrame.id, newFrame.id, 8)
  check(false, 'overlapping live bake conflicts')
} catch (error) {
  const e = error as { kind?: number; tag?: string; requested?: unknown[]; inFlight?: unknown[] }
  check(
    e.kind === 2 && e.tag === 'bake' && Array.isArray(e.requested) && Array.isArray(e.inFlight),
    `overlapping live bake conflicts with structured error (kind=${e.kind}, tag=${e.tag})`,
  )
}
// free() releases the pair; afterwards the bake goes through (cache hit).
session.free()
other.bake(json, json, oldFrame.id, newFrame.id, 8)
stats = JSON.parse(other.stats_json())
check(stats.hits === 2, `after free the freed pair hits the warm cache ${JSON.stringify(stats)}`)
other.free()

if (failures) {
  console.error(`check-bake-session: ${failures} failure(s)`)
  process.exit(1)
}
console.log('check-bake-session: all checks passed')
