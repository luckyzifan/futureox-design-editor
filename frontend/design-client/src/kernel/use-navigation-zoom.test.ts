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
    render(zoom: number, identity = 'document', enabled = true) {
      state = ref = effect = 0; layouts = []
      const internal = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internal.H
      let value: ReturnType<typeof useNavigationZoom>
      try { internal.H = dispatcher; value = useNavigationZoom({ x: 0, y: 0, zoom }, identity, enabled) }
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
