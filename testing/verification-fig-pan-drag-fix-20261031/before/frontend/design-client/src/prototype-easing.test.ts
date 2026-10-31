import { expect, test } from 'vitest'
import { blank, node } from './model'
import { prototypeEase, prototypeEvent, initialPrototype } from './prototype'

test('prototype easing maps time through the kernel curve set', () => {
  expect(prototypeEase(undefined, 0.5)).toBe(0.5)
  expect(prototypeEase('linear', 0.25)).toBe(0.25)
  expect(prototypeEase('ease-in', 0.5)).toBeLessThan(0.5)
  expect(prototypeEase('ease-out', 0.5)).toBeGreaterThan(0.5)
  const inout = prototypeEase('ease-in-out', 0.5)
  expect(inout).toBeCloseTo(0.5, 3)
  // cubic anchors: ease-in-out at t=0.25 sits below the diagonal
  expect(prototypeEase('ease-in-out', 0.25)).toBeLessThan(0.25)
  // boundaries are exact and never exceed the sampler domain
  expect(prototypeEase('ease-in', 0)).toBe(0)
  expect(prototypeEase('spring', 1)).toBe(1)
  // the default animation spring settles near 1 without leaving [0,1]+overshoot
  const settled = prototypeEase('spring', 0.999)
  expect(Math.abs(settled - 1)).toBeLessThan(0.35)
})

test('prototype events carry the easing curve into the transition state', () => {
  const d = blank()
  const a = node('frame', 0, 0, 100, 100),
    b = node('frame', 120, 0, 100, 100)
  d.nodes[a.id] = a
  d.nodes[b.id] = b
  d.pages[0].children = [a.id, b.id]
  d.prototype = {
    interactions: {
      [a.id]: [
        {
          trigger: 'click',
          actions: [
            {
              kind: 'navigate',
              target: b.id,
              durationMs: 400,
              easingCurve: 'ease-in-out',
            },
          ],
        },
      ],
    },
  }
  const state = prototypeEvent(d, initialPrototype(d), a.id, 'click')
  expect(state.transitionMs).toBe(400)
  expect(state.transitionEasing).toBe('ease-in-out')
  expect(state.current).toBe(b.id)
})
