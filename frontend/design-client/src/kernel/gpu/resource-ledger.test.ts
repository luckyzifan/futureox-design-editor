import { expect, test } from 'vitest'
import { ResourceLedger, sceneResidencyCondition, residencyBaseKey, residencyConditionKey } from './resource-ledger'

type Tex = { id: number; bytes: number }
type Surf = { texture: Tex }

test('alias holders stay out of the pool and the last release returns it', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  const texture = { id: 1, bytes: 64 }
  const first = { texture }, second = { texture }
  ledger.retain(texture)
  expect(ledger.beginRelease(first)).toBe('held')
  expect(ledger.aliases.size).toBe(1)
  expect(ledger.beginRelease(first)).toBe('skip')
  expect(ledger.beginRelease(second)).toBe('pool')
  expect(ledger.aliases.size).toBe(0)
})

test('pool return records the encode epoch and completion is a separate life', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  const texture = { id: 2, bytes: 32 }
  ledger.charge(32)
  ledger.notePoolReturn(texture, 4)
  expect(ledger.life({ busy: true, poolEpoch: 4, completedEpoch: 9 })).toBe('active')
  expect(ledger.life({ busy: false, poolEpoch: 4, completedEpoch: 3 })).toBe('retired-pending-completion')
  expect(ledger.life({ busy: false, poolEpoch: 4, completedEpoch: 4 })).toBe('reclaimable')
  expect(ledger.life({ busy: false })).toBe('untracked')
  ledger.discharge(32)
  expect(ledger.bytes).toBe(0)
  expect(ledger.peak).toBe(32)
})

test('completed free-pool bytes are counted apart from the high-water peak', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  ledger.charge(128)
  ledger.noteCompletedFree(64)
  ledger.noteCompletedFree(0)
  ledger.noteCompletedFree(Number.NaN)
  ledger.discharge(64)
  expect(ledger.completedFreeBytes).toBe(64)
  expect(ledger.bytes).toBe(64)
  expect(ledger.peak).toBe(128)
})

test('device loss forgets owners without pretending the bytes were destroyed', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  const texture = { id: 3, bytes: 8 }
  const surface = { texture }
  ledger.charge(8)
  ledger.retain(texture)
  ledger.beginRelease(surface)
  ledger.notePoolReturn(texture, 1)
  ledger.forgetOwners()
  expect(ledger.aliases.size).toBe(0)
  expect(ledger.beginRelease(surface)).toBe('pool')
  expect(ledger.life({ busy: false, poolEpoch: ledger.poolEpochs.get(texture), completedEpoch: 1 })).toBe('reclaimable')
  expect(ledger.bytes).toBe(8)
  expect(ledger.peak).toBe(8)
})

test('a new peak records the class that caused it and completion does not lower it', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  ledger.charge(32, 'scratch')
  const first = { id: 4, bytes: 64 }
  const second = { id: 5, bytes: 64 }
  ledger.chargeTracked(first, 'surface')
  ledger.chargeTracked(second, 'image')
  expect(ledger.bytes).toBe(160)
  expect(ledger.peak).toBe(160)
  expect(ledger.peakSample).toMatchObject({
    chargedBytes: 160,
    classes: { scratch: 32, surface: 64, image: 64 },
    life: { active: 128, 'retired-pending-completion': 0, reclaimable: 0 },
  })
  ledger.park(first, 4, 1)
  ledger.park(second, 2, 2)
  expect(ledger.lifeBytes.active).toBe(0)
  expect(ledger.lifeBytes['retired-pending-completion']).toBe(64)
  expect(ledger.lifeBytes.reclaimable).toBe(64)
  expect(ledger.peak).toBe(160)
  ledger.noteCompletion(4)
  expect(ledger.lifeBytes['retired-pending-completion']).toBe(0)
  expect(ledger.lifeBytes.reclaimable).toBe(128)
  expect(ledger.completionSample?.chargedBytes).toBe(160)
  ledger.dischargeTracked(first, 4)
  ledger.noteCompletedFree(64)
  expect(ledger.bytes).toBe(96)
  expect(ledger.peak).toBe(160)
  expect(ledger.completedFreeBytes).toBe(64)
  expect(ledger.lifeBytes.reclaimable).toBe(64)
  expect(ledger.classes.surface).toBe(0)
  expect(ledger.classes.image).toBe(64)
  expect(ledger.classes.scratch).toBe(32)
  ledger.unpark(second, 4)
  expect(ledger.lifeBytes.active).toBe(64)
  expect(ledger.lifeBytes.reclaimable).toBe(0)
  expect(ledger.bytes).toBe(96)
})

test('same-condition trend keeps retired bytes until a physical release', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  const cold = sceneResidencyCondition({
    view: { x: 1, y: 2, zoom: 0.5, dpr: 2 }, width: 100, height: 80,
    extent: { w: 1000, h: 800 }, densePaint: { width: 32, height: 16, nodes: { b: 1, a: 2 }, sources: { s: 0 } },
    resolve: { scale: 1 },
  }, false)
  const reordered = sceneResidencyCondition({
    view: { x: 1, y: 2, zoom: 0.5, dpr: 2 }, width: 100, height: 80,
    extent: { w: 1000, h: 800 }, densePaint: { width: 32, height: 16, nodes: { a: 2, b: 1 }, sources: { s: 0 } },
    resolve: { scale: 1 },
  }, false)
  expect(cold && reordered && residencyBaseKey(cold) === residencyBaseKey(reordered)).toBe(true)
  expect(ledger.bindCondition(cold!)).toBe(true)
  const spare = { id: 8, bytes: 128, width: 4, height: 8 }
  const kept = { id: 9, bytes: 64, width: 4, height: 4 }
  ledger.chargeTracked(spare, 'surface')
  ledger.chargeTracked(kept, 'surface')
  ledger.park(spare, 2, 1)
  ledger.park(kept, 2, 1)
  const pending = ledger.recordCycle(1, 0)
  expect(pending?.stableBytes).toBe(192)
  expect(pending?.life['retired-pending-completion']).toBe(192)
  expect(ledger.bytes).toBe(192)
  expect(ledger.peak).toBe(192)
  ledger.dischargeTracked(spare, 2)
  ledger.noteCompletedFree(128)
  const warm = { ...cold!, thermal: 'warm' as const }
  expect(residencyConditionKey(warm)).not.toBe(residencyConditionKey(cold!))
  expect(ledger.bindCondition(warm)).toBe(true)
  const released = ledger.recordCycle(2, 128)
  expect(released?.stableBytes).toBe(64)
  expect(released?.life.reclaimable).toBe(64)
  expect(released?.life['retired-pending-completion']).toBe(0)
  expect(ledger.peak).toBe(192)
  expect(ledger.resources(2).map(row => row.bytes)).toEqual([64])
  expect(ledger.resources(2)[0]).toMatchObject({ class: 'surface', width: 4, height: 4, life: 'reclaimable' })
  ledger.bindCondition(warm)
  ledger.recordCycle(2, 0)
  const trend = ledger.pressureTrend()
  expect(trend.cycles).toBe(2)
  expect(trend.stableBytes).toEqual([64, 64])
  expect(trend.grew).toBe(false)
  expect(trend.delta).toBe(0)
  expect(trend.thermal).toBe('warm')
  const other = sceneResidencyCondition({ view: { x: 1, y: 2, zoom: 0.5, dpr: 1 }, width: 100, height: 80 }, false)
  expect(ledger.bindCondition(other!)).toBe(true)
  ledger.recordCycle(2, 0)
  expect(ledger.pressureTrend().cycles).toBe(1)
  expect(ledger.pressureTrend().stableBytes).toEqual([64])
  expect(ledger.crossConditionResets).toBe(2)
  expect(sceneResidencyCondition({ view: { x: 0, y: 0, zoom: 1, dpr: Number.NaN } }, false)).toBeUndefined()
})
