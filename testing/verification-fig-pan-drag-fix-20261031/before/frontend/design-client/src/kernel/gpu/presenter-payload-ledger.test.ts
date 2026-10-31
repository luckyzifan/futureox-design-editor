import { afterEach, expect, test, vi } from 'vitest'
import { PresenterPayloadLedger } from './presenter-payload-ledger'
afterEach(() => vi.useRealTimers())
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function fixture(budget = 100) {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = []
  const queue = vi.fn(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })))
  return { ledger: new PresenterPayloadLedger(queue, budget, () => 0, 100), queue, pending }
}
test('unpressured reservation, commit and exact once cancel do not fence', () => {
  const { ledger, queue } = fixture(), live = ledger.reserve(40), unused = ledger.reserve(20)
  ledger.commit(live); ledger.cancel(unused); ledger.cancel(unused)
  expect(ledger.snapshot()).toMatchObject({ liveBytes: 40, allocationReservedBytes: 0, retiringBytes: 0 })
  expect(queue).not.toHaveBeenCalled()
  expect(() => ledger.reserve(61)).toThrow(/budget exceeded/)
  for (const bytes of [0, -1, NaN, Infinity, 1.2]) expect(() => ledger.reserve(bytes)).toThrow(/invalid payload/)
})
test('immutable prefix cohorts keep later retirements charged with one observer', async () => {
  const { ledger, queue, pending } = fixture(), first = ledger.reserve(30), second = ledger.reserve(40)
  ledger.commit(first); ledger.commit(second); ledger.retire(first); ledger.retire(second); ledger.retire(first)
  expect(queue).toHaveBeenCalledTimes(1); expect(ledger.snapshot().retiringBytes).toBe(70)
  expect(() => ledger.reserve(31)).toThrow(/budget exceeded/)
  pending[0].resolve(); await flush()
  expect(queue).toHaveBeenCalledTimes(2); expect(ledger.snapshot().retiringBytes).toBe(40)
  pending[1].resolve(); await flush(); expect(ledger.snapshot().retiringBytes).toBe(0)
})
test('retirement cohort is detached before a reentrant prefix callback', async () => {
  let ledger: PresenterPayloadLedger, second: ReturnType<PresenterPayloadLedger['reserve']>, calls = 0
  const pending: (() => void)[] = []
  ledger = new PresenterPayloadLedger(() => { if (++calls === 1) ledger.retire(second); return new Promise(resolve => pending.push(resolve)) }, 100)
  const first = ledger.reserve(30); second = ledger.reserve(40); ledger.commit(first); ledger.commit(second)
  ledger.retire(first); expect(calls).toBe(1); pending[0](); await flush()
  expect(ledger.snapshot().retiringBytes).toBe(40); expect(calls).toBe(2); pending[1](); await flush()
})
test('one active capture, bounded explicit admission wait, released output admits next', async () => {
  const { ledger, queue } = fixture(), first = await ledger.reserveAsync(40, 'capture')
  let admitted = false
  const second = ledger.reserveAsync(40, 'capture').then(token => { admitted = true; return token })
  await flush(); expect(admitted).toBe(false); expect(ledger.snapshot()).toMatchObject({ captureReservedBytes: 40, waiters: 1 })
  ledger.complete(first); const next = await second; expect(admitted).toBe(true)
  ledger.complete(next); expect(ledger.snapshot()).toMatchObject({ pendingCaptures: 0, captureReservedBytes: 0, waiters: 0 })
  expect(queue).not.toHaveBeenCalled()
})
test('impossible fit rejects without waiting; timeout never credits unfinished output', async () => {
  vi.useFakeTimers()
  const { ledger } = fixture(), live = ledger.reserve(80); ledger.commit(live)
  await expect(ledger.reserveAsync(21, 'capture')).rejects.toThrow(/cannot fit/)
  const first = await ledger.reserveAsync(20, 'capture')
  const waiting = ledger.reserveAsync(20, 'capture'), rejected = expect(waiting).rejects.toThrow(/timed out/)
  await vi.advanceTimersByTimeAsync(100); await rejected
  expect(ledger.snapshot()).toMatchObject({ captureReservedBytes: 20, pendingCaptures: 1, waiters: 0 })
  ledger.complete(first)
})
test('waiters admit only after the covering retirement prefix settles', async () => {
  const { ledger, pending } = fixture(), live = ledger.reserve(80); ledger.commit(live); ledger.retire(live)
  const output = ledger.reserveAsync(40, 'capture'); expect(ledger.snapshot().waiters).toBe(1)
  pending[0].resolve(); await flush(); const token = await output
  expect(ledger.snapshot()).toMatchObject({ retiringBytes: 0, captureReservedBytes: 40 }); ledger.complete(token)
})
test('known loss rejects all waiters and old resolution cannot credit fresh incarnation', async () => {
  const old = fixture(), live = old.ledger.reserve(80); old.ledger.commit(live); old.ledger.retire(live)
  const first = expect(old.ledger.reserveAsync(40, 'capture')).rejects.toThrow(/retired or device lost/)
  const second = expect(old.ledger.reserveAsync(40, 'readback')).rejects.toThrow(/retired or device lost/)
  old.ledger.close('lost'); await first; await second
  const fresh = fixture(), next = fresh.ledger.reserve(50); fresh.ledger.commit(next)
  old.pending[0].resolve(); await flush()
  expect(old.ledger.snapshot()).toMatchObject({ retiringBytes: 80, closed: 2, waiters: 0 })
  expect(fresh.ledger.snapshot()).toMatchObject({ liveBytes: 50, retiringBytes: 0, closed: 0 })
  expect(() => fresh.ledger.retire(live)).toThrow(/owner mismatch/)
})
test('queue rejection retains charged bytes and fails waiters and future admission', async () => {
  const { ledger, pending } = fixture(), live = ledger.reserve(80); ledger.commit(live); ledger.retire(live)
  const rejected = expect(ledger.reserveAsync(40, 'capture')).rejects.toThrow(/queue completion failed/)
  pending[0].reject(Error('private backend error')); await rejected
  expect(ledger.snapshot()).toMatchObject({ retiringBytes: 80, closed: 3, waiters: 0 })
  expect(() => ledger.reserve(1)).toThrow(/retired or completion unavailable/)
})
test('synchronous prefix failure and disposed closure never zero charged bytes', async () => {
  const ledger = new PresenterPayloadLedger(() => { throw Error('queue unavailable') }, 100)
  const live = ledger.reserve(40); ledger.commit(live); ledger.retire(live)
  expect(ledger.snapshot()).toMatchObject({ retiringBytes: 40, closed: 3 })
  const next = fixture(), token = next.ledger.reserve(50); next.ledger.commit(token); next.ledger.close('disposed'); next.ledger.retire(token)
  expect(next.ledger.snapshot()).toMatchObject({ liveBytes: 0, retiringBytes: 50, closed: 1 }); expect(next.queue).not.toHaveBeenCalled()
})

test('small explicit pixel readbacks are count-bounded even when payload headroom is large', async()=>{
  const ledger=new PresenterPayloadLedger(()=>Promise.resolve(),1024)
  const active=await Promise.all(Array.from({length:8},()=>ledger.reserveAsync(1,'readback')))
  const next=ledger.reserveAsync(1,'readback')
  expect(ledger.snapshot()).toMatchObject({pendingReadbacks:8,readbackReservedBytes:8,waiters:1})
  ledger.complete(active.pop()!);const token=await next
  expect(ledger.snapshot()).toMatchObject({pendingReadbacks:8,readbackReservedBytes:8,waiters:0})
  for(const item of [...active,token])ledger.complete(item)
})
