import { expect, test } from 'vitest'
import { ResourceLedger } from './resource-ledger'

type Tex = { id: number; bytes: number }
type Surf = { texture: Tex }

test('alias holders stay out of the pool and the last release returns it', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  const texture = { id: 1, bytes: 64 }
  const first = { texture }, second = { texture }
  ledger.retain(texture)
  expect(ledger.beginRelease(first)).toBe('held')
  expect(ledger.aliasesFor(texture)).toBe(1)
  expect(ledger.isReleased(first)).toBe(true)
  expect(ledger.beginRelease(first)).toBe('skip')
  expect(ledger.beginRelease(second)).toBe('pool')
  expect(ledger.aliasesFor(texture)).toBeUndefined()
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

test('a positive pool stamp stays pending until that device epoch completes', () => {
  const ledger = new ResourceLedger<Tex, Surf>()
  expect(ledger.poolReleasePending(4, 3)).toBe(true)
  expect(ledger.poolReleasePending(4, 4)).toBe(false)
  expect(ledger.poolReleasePending(4, undefined)).toBe(true)
  expect(ledger.poolReleasePending(4, Number.NaN)).toBe(true)
  expect(ledger.poolReleasePending(undefined, 4)).toBe(false)
  expect(ledger.poolReleasePending(0, 4)).toBe(false)
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
  expect(ledger.aliasesFor(texture)).toBeUndefined()
  expect(ledger.isReleased(surface)).toBe(false)
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
