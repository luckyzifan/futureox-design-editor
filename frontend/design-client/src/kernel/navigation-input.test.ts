import { expect, test, vi } from 'vitest'
import { bindNavigationInput, recordNavigationInput, NavigationInputTrace } from './navigation-input'
import { NavigationJournal, type NavigationJournalClock } from './navigation-journal'
import { createRenderDiagnostics, sanitizeRecord } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'

const size = { width: 1000, height: 800 }, view = { x: 317, y: -442, zoom: 2 }
function fixture(terminalEnabled = false) {
  let at = 10
  const now = vi.fn(() => at), origin = vi.fn(() => 123456)
  const clock: NavigationJournalClock = { now, timeOrigin: 123456, schedule: () => 1, cancel() {} }
  const journal = new NavigationJournal(clock)
  const rows: any[] = []
  const terminal = createRenderDiagnostics({ enabled: terminalEnabled, now: () => at,
    schedule: (() => 1) as any, cancel: (() => {}) as any, sink: row => rows.push(row) })
  const trace = new NavigationInputTrace(journal, terminal, now, origin)
  const owner = {}, unbind = bindNavigationInput(owner, trace)
  const input = (deltaMode = 0) => recordNavigationInput(owner, { deltaX: 0, deltaY: -2, deltaMode }, size, view, true)
  return { now, origin, journal, terminal, rows, trace, owner, unbind, input, setAt: (value: number) => { at = value } }
}
test('disabled actual input route reads no clock, produces no output, and keeps no correlation', () => {
  const f = fixture()
  for (let i = 0; i < 10000; i++) f.input()
  expect(f.now).not.toHaveBeenCalled(); expect(f.origin).not.toHaveBeenCalled()
  expect(f.rows).toEqual([]); expect(f.journal.report().events).toEqual([])
  expect(f.trace.correlation(view)).toEqual({}); f.unbind()
})
test('enabled owner route records normalized scalar input then exact latest stage2 correlation', () => {
  const f = fixture(); f.journal.start({ capacity: 16 })
  f.input(1); f.setAt(14)
  const link = f.trace.correlation(view)
  f.journal.record(2, { sequence: 55, ...link })
  expect(f.journal.report().events).toEqual([
    { stage: 1, at: 10, inputSequence: 1, inputAt: 10, inputTimeOrigin: 123456,
      deltaX: 0, deltaY: -32, deltaMode: 1, inputKind: 2, ...view },
    { stage: 2, at: 14, sequence: 55, inputSequence: 1, inputAt: 10, inputTimeOrigin: 123456, inputAgeMs: 4 },
  ])
  expect(f.trace.correlation({ ...view })).toEqual({})
  expect(f.trace.correlation({ ...view, zoom: 1 })).toEqual({})
  recordNavigationInput({}, { deltaX: 0, deltaY: -3, deltaMode: 0 }, size, view, false)
  expect(f.journal.report().events).toHaveLength(2)
  f.unbind(); f.input(); expect(f.journal.report().events).toHaveLength(2)
})
test('ring and terminal rate remain bounded during 10000 input events; no text or raw keys survive', () => {
  const f = fixture(true); f.journal.start({ capacity: 16 })
  for (let i = 0; i < 10000; i++) f.input()
  expect(f.journal.report().events).toHaveLength(16)
  expect(f.journal.report().dropped).toBe(9984)
  expect(f.rows).toHaveLength(8)
  f.terminal.flush()
  expect(f.rows).toHaveLength(10)
  expect(f.rows.at(-1)).toMatchObject({ event: 'camera-input', inputSequence: 10000, sampleCount: 9992, inputAt: 10 })
  const clean = sanitizeRecord({ ...f.rows.at(-1), text: 'private', key: 'secret', document: { id: 'private' }, deltaY: Infinity })
  expect(clean).not.toHaveProperty('text'); expect(clean).not.toHaveProperty('key')
  expect(clean).not.toHaveProperty('document'); expect(clean).not.toHaveProperty('deltaY')
  f.unbind(); f.terminal.close()
})
test('new diagnostic generation cannot correlate an input from an earlier capture', () => {
  const f = fixture(); f.journal.start(); f.input(); f.journal.stop(); f.journal.start()
  expect(f.trace.correlation(view)).toEqual({})
  f.input(); expect(f.trace.correlation(view).inputSequence).toBe(2)
  f.trace.reset(); expect(f.trace.correlation(view)).toEqual({}); f.unbind()
})
test('unavailable telemetry cannot throw into the accepted wheel handler', () => {
  const owner = {}
  const stop = bindNavigationInput(owner, { enabled: () => true, record() { throw Error('diagnostic only') } })
  expect(() => recordNavigationInput(owner, { deltaX: 0, deltaY: 1, deltaMode: 0 }, size, view, false)).not.toThrow()
  stop()
})
