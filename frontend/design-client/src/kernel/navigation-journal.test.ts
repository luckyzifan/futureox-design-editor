import { describe, expect, it, vi } from 'vitest'
import { NavigationJournal, validateNavigationJournalOptions, type NavigationJournalClock } from './navigation-journal'
function setup() {
  let now = 10
  const callbacks: Array<() => void> = []
  const clock: NavigationJournalClock = {
    now: vi.fn(() => now), timeOrigin: 123456,
    schedule: vi.fn(callback => { callbacks.push(callback); return callbacks.length }), cancel: vi.fn(),
  }
  return { journal: new NavigationJournal(clock), clock, callbacks, setNow: (value: number) => { now = value } }
}
describe('NavigationJournal', () => {
  it('performs zero clock reads while disabled', () => {
    const { journal, clock } = setup()
    journal.record(1); journal.report()
    expect(clock.now).not.toHaveBeenCalled()
    expect(journal.recording).toBe(false)
    journal.start(); journal.stop()
    vi.mocked(clock.now).mockClear()
    journal.record(1); journal.dispose(); journal.record(1)
    expect(clock.now).not.toHaveBeenCalled()
  })
  it('wraps in chronological order and counts overwritten events', () => {
    const { journal } = setup()
    journal.start({ capacity: 16 })
    for (let sequence = 0; sequence < 40; sequence++) journal.record(1, { sequence })
    const report = journal.report()
    expect(report.events.map(event => event.sequence)).toEqual(Array.from({ length: 16 }, (_, i) => i + 24))
    expect(report.dropped).toBe(24)
    expect(report.timeOrigin).toBe(123456)
    expect(report.clock).toBe('performance.now')
    expect(report.events[0].at).toBe(10)
    report.events[0].sequence = -1
    expect(journal.report().events[0].sequence).toBe(24)
  })
  it('stops manually and cancels its timer', () => {
    const { journal, clock } = setup()
    journal.start(); journal.record(1); journal.stop(); journal.record(2)
    expect(clock.cancel).toHaveBeenCalledWith(1)
    expect(journal.report()).toMatchObject({ recording: false, stopReason: 1, events: [{ at: 10, stage: 1 }] })
  })
  it('changes the generation across stop and restart to reject stale async work', () => {
    const { journal } = setup()
    journal.start()
    const first = journal.generation
    journal.stop(5)
    expect(journal.generation).not.toBe(first)
    journal.start()
    const second = journal.generation
    expect(second).not.toBe(first)
    journal.record(1)
    expect(journal.generation).toBe(second)
  })
  it('restarts with a fresh buffer and invalidates the cancelled timer', () => {
    const { journal, clock, callbacks } = setup()
    journal.start({ capacity: 16 }); journal.record(1)
    journal.start({ capacity: 32, durationMs: 100 })
    expect(clock.cancel).toHaveBeenCalledWith(1)
    expect(clock.schedule).toHaveBeenLastCalledWith(expect.any(Function), 100)
    callbacks[0]()
    expect(journal.report()).toMatchObject({ capacity: 32, recording: true, events: [], dropped: 0, stopReason: 0 })
    callbacks[1]()
    expect(journal.report()).toMatchObject({ recording: false, stopReason: 2 })
  })
  it('enforces the deadline when timer delivery is delayed', () => {
    const { journal, setNow } = setup()
    journal.start({ durationMs: 100 }); setNow(110); journal.record(1)
    expect(journal.report()).toMatchObject({ recording: false, stopReason: 2, events: [] })
  })
  it.each([3, 5])('retains explicit stop reason %i across repeated stops', reason => {
    const { journal } = setup()
    journal.start(); journal.stop(reason); journal.stop()
    expect(journal.report().stopReason).toBe(reason)
  })
  it('disposes with reason 4 and cancels its timer', () => {
    const { journal, clock } = setup()
    journal.start(); journal.dispose()
    expect(clock.cancel).toHaveBeenCalledWith(1)
    expect(journal.report()).toMatchObject({ recording: false, stopReason: 4 })
  })
  it('validates bounds without altering the running session', () => {
    const { journal } = setup()
    journal.start()
    for (const capacity of [0, 15, 4097, 16.5, NaN, Infinity]) expect(() => journal.start({ capacity })).toThrow(RangeError)
    for (const durationMs of [0, 99, 30001, NaN, Infinity]) expect(() => journal.start({ durationMs })).toThrow(RangeError)
    expect(journal.recording).toBe(true)
    for (const reason of [0, 6, 1.5, NaN]) expect(() => journal.stop(reason)).toThrow(RangeError)
    journal.start({ capacity: 4096, durationMs: 30000 })
    expect(journal.report().capacity).toBe(4096)
  })
  it('rejects malformed options and unknown keys', () => {
    for (const options of [undefined, null, [], 'bad', 5, { action: 'start' }, { capacity: null }, { durationMs: '100' }, { [Symbol()]: 1 }]) {
      expect(() => validateNavigationJournalOptions(options)).toThrow()
    }
    expect(validateNavigationJournalOptions({})).toEqual({ capacity: 2048, durationMs: 10000 })
  })
  it('retains only valid stages and finite allowlisted numeric own fields', () => {
    const { journal } = setup()
    journal.start()
    for (const stage of [0, 11, 1.5, NaN, Infinity]) journal.record(stage)
    const values = Object.assign(Object.create({ frames: 99 }), {
      requestId: 1, sequence: 2, channel: 3, x: 4, y: 5, zoom: 6, width: 7, height: 8,
      compileMs: 9, graphMs: 10, finishMs: 11, tiles: 12,
      name: 'secret', payload: { secret: 'hidden' }, id: 'secret', at: -1, stage: 8,
    })
    journal.record(10, values)
    journal.record(1, { x: NaN, y: Infinity, zoom: -Infinity, frames: 'secret' } as unknown as Record<string, number>)
    expect(journal.report().events).toEqual([
      { at: 10, stage: 10, requestId: 1, sequence: 2, channel: 3, x: 4, y: 5, zoom: 6,
        width: 7, height: 8, compileMs: 9, graphMs: 10, finishMs: 11, tiles: 12 },
      { at: 10, stage: 1 },
    ])
  })
})
