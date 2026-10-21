import { expect, test } from 'vitest'
import { estimatedTileResidencyBytes } from './page-memory-policy'
import { planTileAdmission, replacementTileBudget, TileAdmissionBudgetError } from './tile-admission'
const MiB = 1024 * 1024, steady = 128 * MiB, total = 224 * MiB
const viewport = { width: 855, height: 888, dpr: 2, bytesPerPixel: 4 }
const tile = (index: number) => ({ key: `owned-${index}`, gpuTile: index + 1, bytes: new Uint8Array(), width: 512, height: 512 })

test('all-hot old coverage admits current foreground replacements and returns to steady allowance after their ACK', () => {
  const old = Array.from({ length: 128 }, (_, i) => tile(i)), used = new Set(old)
  let live = new Map(old.map(value => [value.key, value]))
  const allowance = replacementTileBudget(steady, total, viewport, true)
  expect(allowance.reserveBytes).toBe(26_419_600)
  expect(allowance.budgetBytes).toBeLessThanOrEqual(total)
  expect(() => planTileAdmission(live, tile(128), { budget: steady, used, held: old.slice(0, 28), pinned: () => true }))
    .toThrow(TileAdmissionBudgetError)
  const next = [128, 129, 130, 131].map(tile)
  for (const incoming of next) live = planTileAdmission(live, incoming, { ...allowance, budget: allowance.budgetBytes,
    used, held: old.slice(0, 28), pinned: key => next.some(value => value.key === key) }).map
  expect(estimatedTileResidencyBytes(live.values())).toBe(132 * MiB)
  expect([...used].every(value => live.get(value.key) === value)).toBe(true)
  // The actual replacement ACK changes visible ownership; the old complete
  // frame remains held until React swaps it, but old fragments no longer pin.
  const completed = planTileAdmission(live, next[3], { budget: steady, used: new Set(next), held: old.slice(0, 28),
    pinned: key => next.some(value => value.key === key) })
  expect(estimatedTileResidencyBytes([...completed.map.values(), ...completed.held])).toBeLessThanOrEqual(steady)
  expect(next.every(value => completed.map.get(value.key) === value)).toBe(true)
})

test('one-frame staging is recomputed under viewport changes and cannot accumulate across requests', () => {
  const old = Array.from({ length: 128 }, (_, i) => tile(i)), used = new Set(old)
  let live = new Map(old.map(value => [value.key, value]))
  for (let request = 0; request < 40; request++) {
    const incoming = tile(128 + request), allowance = replacementTileBudget(steady, total,
      { ...viewport, width: request % 2 ? 855 : 1000 }, true)
    const planned = planTileAdmission(live, incoming, { budget: allowance.budgetBytes, reserveBytes: allowance.reserveBytes,
      used, held: [], pinned: key => key === incoming.key })
    live = planned.map
    expect(planned.bytes).toBeLessThanOrEqual(allowance.budgetBytes)
    expect(allowance.reserveBytes).toBeLessThanOrEqual(Math.floor(steady / 3))
    expect(allowance.budgetBytes).toBeLessThanOrEqual(total)
  }
})

test.each(['prefetch', 'stale camera'])('%s cannot borrow foreground replacement room', () => {
  const allowance = replacementTileBudget(steady, total, viewport, false)
  expect(allowance).toEqual({ reserveBytes: 0, budgetBytes: steady })
  const all = Array.from({ length: 128 }, (_, i) => tile(i)), live = new Map(all.map(value => [value.key, value]))
  try {
    planTileAdmission(live, tile(128), { budget: allowance.budgetBytes, used: new Set(all), held: [], pinned: () => true })
    throw Error('Expected bounded admission rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(TileAdmissionBudgetError)
    const detail = (error as TileAdmissionBudgetError).diagnostic
    expect(detail).toEqual({ proposedBytes: 129 * MiB, budgetBytes: steady, incomingBytes: MiB,
      reserveBytes: 0, usedCount: 128, pinnedCount: 129, heldCount: 0 })
    expect([...live.values()]).toEqual(all)
  }
})

test('low-tier total headroom and the existing one-third active allowance bound every staging cap', () => {
  const huge = { width: 4000, height: 3000, dpr: 2, bytesPerPixel: 28 }
  for (const room of [0, 8, 32, 96]) {
    const cap = replacementTileBudget(steady, steady + room * MiB, huge, true)
    expect(cap.reserveBytes).toBe(Math.min(room * MiB, Math.floor(steady / 3)))
    expect(cap.budgetBytes).toBeLessThanOrEqual(steady + room * MiB)
  }
  expect(replacementTileBudget(steady, total, { ...viewport, width: Infinity }, true).reserveBytes).toBe(0)
})
