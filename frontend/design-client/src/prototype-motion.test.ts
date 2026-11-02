import { expect, test } from 'vitest'
import { blank, effect, node } from './model'
import { initialPrototype, prototypeEvent } from './prototype'
import { lightenPrototypeMotion, PROTOTYPE_MOTION_CAPS } from './prototype-motion'

test('in-between frames cap glass and blur and leave opacity and transform alone', () => {
  const doc = blank('motion')
  const glass = node('rectangle', 10, 20, 80, 40)
  glass.opacity = 0.4
  glass.transform = [0.6, 0.8, -0.8, 0.6, 30, 40]
  glass.effects = [
    { ...effect('glass'), radius: 40, glass: { depth: 40, refraction: 0.9, dispersion: 0.8, lightAngle: 12, lightIntensity: 0.4, bevelSize: 10 } },
    { ...effect('blur'), radius: 48 },
    { ...effect('shadow'), radius: 6 },
  ]
  doc.nodes[glass.id] = glass
  const next = lightenPrototypeMotion(doc)
  const nodeAfter = next.nodes[glass.id]
  expect(nodeAfter.opacity).toBe(0.4)
  expect(nodeAfter.transform).toEqual(glass.transform)
  expect(nodeAfter.effects[0].radius).toBe(PROTOTYPE_MOTION_CAPS.blur)
  expect(nodeAfter.effects[0].glass).toMatchObject({
    depth: PROTOTYPE_MOTION_CAPS.glassDepth,
    refraction: PROTOTYPE_MOTION_CAPS.glassRefraction,
    dispersion: PROTOTYPE_MOTION_CAPS.glassDispersion,
    bevelSize: 4,
    lightAngle: 12,
  })
  expect(nodeAfter.effects[1].radius).toBe(PROTOTYPE_MOTION_CAPS.blur)
  expect(nodeAfter.effects[2]).toEqual(glass.effects[2])
  expect(lightenPrototypeMotion(next)).toBe(next)
  expect(doc.nodes[glass.id].effects[0].radius).toBe(40)
})

test('a dissolve navigation crossfades without a smart-animate plan', () => {
  const doc = blank('dissolve')
  const from = node('frame', 0, 0, 100, 80)
  const to = node('frame', 200, 0, 100, 80)
  doc.schemaVersion = 20
  doc.nodes = { [from.id]: from, [to.id]: to }
  doc.pages[0].children = [from.id, to.id]
  const next = prototypeEvent(doc, initialPrototype(doc), from.id, 'click', {
    trigger: 'click',
    actions: [{ kind: 'navigate', target: to.id, transitionStyle: 'dissolve', durationMs: 240, easingCurve: 'ease-out' }],
  })
  expect(next.current).toBe(to.id)
  expect(next.transitionStyle).toBe('dissolve')
  expect(next.transition).toBeUndefined()
  expect(next.transitionMs).toBe(240)
})
