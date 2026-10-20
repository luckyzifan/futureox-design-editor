import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { useNavigationZoom } from './use-navigation-zoom'

const owners: (() => void)[] = []
afterEach(() => { owners.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
/** Executes the real hook with a deterministic React dispatcher/RAF clock.
 * No canvas/GPU is created; lifecycle and scheduling are the assertions. */
function harness() {
  const states: any[] = [], refs: any[] = [], effects: any[] = [], frames = new Map<number, FrameRequestCallback>()
  const listeners = new Set<() => void>()
  let state = 0, ref = 0, effect = 0, next = 0, time = 0, layouts: (() => void)[] = []
  const page = { hidden: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
  vi.stubGlobal('document', page)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const dispatcher = {
    useState(initial: any) { const i = state++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], (value: any) => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
    useRef(initial: any) { return refs[ref++] ??= { current: initial } },
    useLayoutEffect(callback: () => any, deps: any[]) {
      const i = effect++, old = effects[i]
      if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) layouts.push(() => {
        old?.cleanup?.(); effects[i] = { deps, cleanup: callback() }
      })
    },
  }
  const dispose = () => effects.forEach(value => value.cleanup?.())
  owners.push(dispose)
  return {
    render(zoom: number, identity = 'document', enabled = true,
      pan: { enabled?: boolean; held?: boolean; x?: number; y?: number } = {}) {
      state = ref = effect = 0; layouts = []
      const internal = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internal.H
      let value: ReturnType<typeof useNavigationZoom>
      try { internal.H = dispatcher; value = useNavigationZoom({ x: pan.x || 0, y: pan.y || 0, zoom },
        identity, enabled, pan.enabled === true, pan.held === true) }
      finally { internal.H = previous }
      layouts.forEach(run => run()); return value!
    },
    frame(at: number) { time = at; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(at)) },
    visibility(hidden: boolean) { page.hidden = hidden; listeners.forEach(listener => listener()) },
    get pending() { return frames.size }, get listeners() { return listeners.size }, dispose,
  }
}

test('first changed input suppresses exact work before the sampled preview layout publication', () => {
  const h = harness()
  expect(h.render(.1).active).toBe(false)
  const changed = h.render(32)
  expect(changed.active).toBe(true)
  expect(changed.sample).toBeUndefined()
  expect(h.render(32).sample?.view.zoom).toBe(32)
  h.frame(160); expect(h.render(32).active).toBe(true)
  h.frame(176); expect(h.render(32).active).toBe(false)
  expect(h.pending).toBe(0)
})

test('pointer pan blocks exact admission from pointerdown and admits final camera on release without quiet delay', () => {
  const h = harness(), pan = { enabled: true, held: true, x: 10.375 }
  h.render(32, 'document', true, { enabled: true })
  expect(h.render(32, 'document', true, pan).active).toBe(true)
  expect(h.render(32, 'document', true, pan).sample?.view.x).toBe(10.375)
  h.frame(5000)
  expect(h.render(32, 'document', true, pan).active).toBe(true)
  const released = h.render(32, 'document', true, { enabled: true, held: false, x: 30.125 })
  expect(released.active).toBe(false)
  expect(released.panEnabled).toBe(true)
  expect(h.render(32, 'document', true, { enabled: true, x: 30.125 }).active).toBe(false)
  expect(h.pending).toBe(0)
})

test('first opted-in wheel-pan input suppresses exact work before the preview layout effect', () => {
  const h = harness()
  h.render(32, 'document', true, { enabled: true })
  const first = h.render(32, 'document', true, { enabled: true, x: 1 })
  expect(first.active).toBe(true); expect(first.sample).toBeUndefined()
  expect(h.render(32, 'document', true, { enabled: true, x: 1 }).sample?.view.x).toBe(1)
  h.frame(160); h.frame(176)
  expect(h.render(32, 'document', true, { enabled: true, x: 1 }).active).toBe(false)
})

test('identity replacement cancels old gesture timers and starts exact at its own camera', () => {
  const h = harness(); h.render(1); h.render(32); h.render(32)
  expect(h.pending).toBe(1)
  expect(h.render(2, 'replacement').active).toBe(false)
  expect(h.pending).toBe(0)
  h.frame(200)
  expect(h.render(2, 'replacement').active).toBe(false)
})

test('object drag or hidden surfaces disable navigation previews and cancel their timer', () => {
  const h = harness(); h.render(1); h.render(32); h.render(32)
  expect(h.render(32, 'document', false).active).toBe(false)
  expect(h.pending).toBe(0)
  expect(h.render(32).active).toBe(false)
})

test('page visibility suspends the gesture and resumes with a final exact target', () => {
  const h = harness(); h.render(1); h.render(32); h.render(32)
  h.visibility(true)
  const hidden = h.render(32)
  expect(hidden.suspended).toBe(true); expect(hidden.active).toBe(false); expect(h.pending).toBe(0)
  h.visibility(false)
  const visible = h.render(32)
  expect(visible.suspended).toBe(false); expect(visible.active).toBe(false)
})

test('unmount removes all gesture frame callbacks and visibility subscriptions', () => {
  const h = harness(); h.render(1); h.render(32)
  expect(h.pending).toBe(1); expect(h.listeners).toBe(1)
  h.dispose()
  expect(h.pending).toBe(0); expect(h.listeners).toBe(0)
})

test('the normal hook keeps conservative 160ms settling with one live RAF subscription', () => {
  const h = harness()
  h.render(1)
  for (let index = 1; index <= 20; index++) {
    h.frame(index * 8)
    expect(h.render(1 + index).active).toBe(true)
    h.render(1 + index)
    expect(h.pending).toBe(1)
  }
  for (let at = 168; at < 320; at += 8) {
    h.frame(at)
    expect(h.render(21).active).toBe(true)
    expect(h.pending).toBe(1)
  }
  h.frame(320)
  expect(h.render(21).active).toBe(false)
  expect(h.pending).toBe(0)
})
