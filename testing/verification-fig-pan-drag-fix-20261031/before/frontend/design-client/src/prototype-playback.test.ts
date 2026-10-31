import { expect, test } from 'vitest'
import { blank, node } from './model'
import { emptySystem } from './design-system'
import { initialPrototype, prototypeDocument, prototypeEase, prototypeEvent } from './prototype'

function fixture() {
  const d = blank(), a = node('frame', 0, 0, 100, 100), b = node('frame', 120, 0, 100, 100)
  d.schemaVersion = 12; d.nodes = { [a.id]: a, [b.id]: b }; d.pages[0].children = [a.id, b.id]
  d.designSystem = { ...emptySystem(), collections: { c: { name: 'Playback', modes: ['base', 'other'], defaultMode: 'base' } },
    variables: { duration: { name: 'Duration', kind: 'number', collection: 'c', values: { base: 400, other: 800 } },
      easing: { name: 'Easing', kind: 'string', collection: 'c', values: { base: 'ease-out-cubic', other: 'linear' } } } }
  return { d, a, b }
}
test('variables resolve at execution time; smart false avoids planning and reset wins over preserve', () => {
  const { d, a, b } = fixture()
  const initial = initialPrototype(d)
  const next = prototypeEvent(d, initial, a.id, 'click', { trigger: 'click', actions: [
    { kind: 'set-variable', target: 'duration', value: 650 },
    { kind: 'navigate', target: b.id, transitionDurationVar: 'duration', transitionEasingVar: 'easing',
      transitionShouldSmartAnimate: false, transitionPreserveScroll: true, transitionResetScrollPosition: true },
  ] })
  expect(next.transitionMs).toBe(650); expect(next.transitionEasing).toBe('ease-out-cubic')
  expect(next.transition).toBeUndefined(); expect(next.navigation?.preserveScroll).toBe(false)
  expect(prototypeEase(next.transitionEasing, .5)).toBeCloseTo(.875)
  expect(initial.current).toBe(a.id); expect(d.designSystem!.variables.duration.values.base).toBe(400)
})
test('explicit variable modes and overlay placement persist only in the playback state', () => {
  const { d, a, b } = fixture()
  const next = prototypeEvent(d, initialPrototype(d), a.id, 'click', { trigger: 'click', actions: [
    { kind: 'set-variable', target: 'duration', targetVariableModeId: 'other', value: 950 },
    { kind: 'overlay', target: b.id, overlayPosition: { origin: 'manual', x: 10, y: 20, padding: 0, background: false } },
  ] })
  expect(next.overlayPositions?.[0]?.x).toBe(10)
  expect(prototypeDocument(d, next).designSystem!.variables.duration.values).toEqual({ base: 400, other: 950 })
  expect(d.designSystem!.variables.duration.values.other).toBe(800)
})
test('unbound hover events do not restart a transition or dirty the render document', () => {
  const { d, a } = fixture(), state = initialPrototype(d)
  expect(prototypeEvent(d, state, a.id, 'hover')).toBe(state)
  const next = prototypeEvent(d, state, a.id, 'click', { trigger: 'click', actions: [{ kind: 'set-variable', target: 'duration', value: 700 }] })
  expect(next.values.duration).toBe(700)
  expect(next.transition).toBeUndefined()
})
