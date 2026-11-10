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
