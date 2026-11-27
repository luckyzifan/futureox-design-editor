import { expect, test } from 'vitest'
import { blank, node } from './model'
import { emptySystem } from './design-system'
import { binfmt_decode, binfmt_encode } from './generated/design-kernel/design_kernel'
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

test('native documents preserve motion variables, and the player resolves their values', () => {
  const d = blank()
  const start = node('frame', 0, 0, 100, 100), end = node('frame', 120, 0, 100, 100)
  d.nodes = { [start.id]: start, [end.id]: end }
  d.pages[0].children = [start.id, end.id]
  d.schemaVersion = 36
  d.designSystem = emptySystem()
  d.designSystem.collections.motion = { name: 'Motion', modes: ['Value'], defaultMode: 'Value' }
  d.designSystem.variables.timing = { kind: 'timing', name: 'Timing', collection: 'motion', values: { Value: 240 } }
  d.designSystem.variables.curve = { kind: 'easing', name: 'Easing', collection: 'motion', values: { Value: 'cubic-bezier(0.42, 0, 1, 1)' } }
  d.prototype = { interactions: { [start.id]: [{ trigger: 'click', actions: [{
    kind: 'navigate', target: end.id, transitionStyle: 'dissolve', transitionDurationVar: 'timing', transitionEasingVar: 'curve',
  }] }] } }
  const decoded = JSON.parse(binfmt_decode(binfmt_encode(JSON.stringify(d)))) as typeof d
  expect(decoded.designSystem?.variables).toEqual(d.designSystem.variables)
  const state = prototypeEvent(decoded, initialPrototype(decoded), start.id, 'click')
  expect(state).toMatchObject({ current: end.id, transitionMs: 240, transitionEasing: 'cubic-bezier(0.42, 0, 1, 1)' })
  expect(prototypeEase(state.transitionEasing, 0.5)).toBeCloseTo(prototypeEase('ease-in', 0.5), 4)
  expect(() => binfmt_encode(JSON.stringify({ ...d, schemaVersion: 35 }))).toThrow()
  d.designSystem.variables.curve.values.Value = 'cubic-bezier(2, 0, 1, 1)'
  expect(() => binfmt_encode(JSON.stringify(d))).toThrow()
})
