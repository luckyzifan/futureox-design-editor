// @vitest-environment jsdom
import { createElement, StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { SHARP_ZOOM_QUIET_MS, useSharpZoomActivity } from './use-sharp-zoom-activity'

const roots = new Set<Root>()
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots.clear(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})
function fixture(strict = false) {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let now = 0, active = false
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const root = createRoot(document.createElement('div')); roots.add(root)
  const history: boolean[] = []
  function Probe({ zoom, identity }: { zoom: number; identity: string }) {
    active = useSharpZoomActivity(zoom, identity); history.push(active); return null
  }
  const render = (zoom: number, identity = 'document-a') => {
    history.length = 0
    act(() => { const child = createElement(Probe, { zoom, identity }); root.render(strict ? createElement(StrictMode, null, child) : child) })
    return history.slice()
  }
  const advance = (milliseconds: number) => { now += milliseconds; act(() => vi.advanceTimersByTime(milliseconds)) }
  return { render, advance, get active() { return active }, unmount() { act(() => root.unmount()); roots.delete(root) } }
}

test('starts in the first changed render and exits only after 100 ms of quiet', () => {
  const f = fixture(); expect(SHARP_ZOOM_QUIET_MS).toBe(100)
  expect(f.render(1)[0]).toBe(false); expect(vi.getTimerCount()).toBe(0)
  expect(f.render(1.05)[0]).toBe(true)
  f.advance(99); expect(f.active).toBe(true)
  f.advance(1); expect(f.active).toBe(false); expect(vi.getTimerCount()).toBe(0)
})

test('ordinary 16 ms wheel gaps never switch back to the exact phase between inputs', () => {
  const f = fixture(); f.render(1)
  for (let i = 1; i <= 60; i++) {
    expect(f.render(1 + i / 20)[0]).toBe(true)
    f.advance(16); expect(f.active).toBe(true); expect(vi.getTimerCount()).toBe(1)
  }
  f.advance(83); expect(f.active).toBe(true)
  f.advance(1); expect(f.active).toBe(false)
})

test('a reversal to the initially committed zoom starts another complete quiet interval', () => {
  const f = fixture(); f.render(1); f.render(2); f.advance(60)
  expect(f.render(1)[0]).toBe(true)
  f.advance(99); expect(f.active).toBe(true)
  f.advance(1); expect(f.active).toBe(false)
})

test('same zoom rerenders do not postpone settlement', () => {
  const f = fixture(); f.render(1); f.render(2); f.advance(75)
  f.render(2); f.advance(24); expect(f.active).toBe(true)
  f.render(2); f.advance(1); expect(f.active).toBe(false)
})

test('new identity immediately resets the old owner and cancels its deadline', () => {
  const f = fixture(); f.render(1); f.render(2); f.advance(50)
  expect(f.render(3, 'document-b')[0]).toBe(false)
  expect(f.active).toBe(false); expect(vi.getTimerCount()).toBe(0)
  f.advance(1000); expect(f.active).toBe(false)
  expect(f.render(4, 'document-b')[0]).toBe(true)
  f.advance(100); expect(f.active).toBe(false)
})

test('wall-clock jumps do not settle a monotonic zoom deadline early', () => {
  const f = fixture(); f.render(1); f.render(2)
  vi.setSystemTime(new Date('2050-01-01T00:00:00Z'))
  f.advance(50); expect(f.active).toBe(true)
  vi.setSystemTime(new Date('2000-01-01T00:00:00Z'))
  f.advance(49); expect(f.active).toBe(true)
  f.advance(1); expect(f.active).toBe(false)
})

test('unmount cancels the only timer and cannot publish to the retired hook', () => {
  const f = fixture(); f.render(1); f.render(2)
  expect(vi.getTimerCount()).toBe(1)
  f.unmount(); expect(vi.getTimerCount()).toBe(0)
  f.advance(1000); expect(vi.getTimerCount()).toBe(0)
})

test('StrictMode keeps a single deadline and does not delay the first changed render', () => {
  const f = fixture(true); f.render(1)
  expect(f.render(2)[0]).toBe(true); expect(vi.getTimerCount()).toBe(1)
  f.advance(99); expect(f.active).toBe(true)
  f.advance(1); expect(f.active).toBe(false); expect(vi.getTimerCount()).toBe(0)
})
