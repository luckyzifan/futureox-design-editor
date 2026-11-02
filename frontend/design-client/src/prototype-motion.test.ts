import { expect, test } from 'vitest'
import { validatePrototype } from './automation/interactions'
import { Editor } from './engine'
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

test('setting dissolve inside an editor draft sticks instead of rolling back', () => {
  const doc = blank('proto')
  const from = node('frame', 0, 0, 100, 80)
  const to = node('frame', 240, 0, 140, 90)
  from.name = 'From'
  to.name = 'To'
  doc.schemaVersion = 12
  doc.nodes = { [from.id]: from, [to.id]: to }
  doc.pages[0].children = [from.id, to.id]
  doc.prototype = {
    interactions: {
      [from.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: to.id, durationMs: 300, easingCurve: 'ease-out' }] }],
    },
  }
  const editor = new Editor(doc)
  const result = editor.change('修改交互', (draft) => {
    draft.prototype!.interactions[from.id][0].actions[0].transitionStyle = 'dissolve'
    validatePrototype(draft, draft.prototype)
  })
  if (result?.status !== 'committed') throw new Error(JSON.stringify({ result, schema: editor.state.doc.schemaVersion, message: editor.state.message }))
  expect(editor.state.doc.prototype?.interactions[from.id][0].actions[0].transitionStyle).toBe('dissolve')
  expect(editor.state.doc.schemaVersion).toBeGreaterThanOrEqual(20)
  const played = prototypeEvent(editor.state.doc, initialPrototype(editor.state.doc), from.id, 'click')
  expect(played.current).toBe(to.id)
  expect(played.transitionStyle).toBe('dissolve')
  expect(played.transition).toBeUndefined()
  editor.dispose()
})

test('a click on a frame hotspot navigates even when smart animate is the stored transition', () => {
  const doc = blank('play')
  const from = node('frame', 0, 0, 160, 100)
  const spot = node('rectangle', 20, 20, 40, 30)
  const to = node('frame', 400, 0, 180, 120)
  from.name = 'Source'
  to.name = 'Destination'
  spot.name = 'Hotspot'
  spot.fills = [{ ...spot.fills[0], color: '#888888' }]
  from.children = [spot.id]
  doc.nodes = { [from.id]: from, [spot.id]: spot, [to.id]: to }
  doc.pages[0].children = [from.id, to.id]
  doc.prototype = {
    interactions: {
      [spot.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: to.id, durationMs: 300, easingCurve: 'ease-out' }] }],
    },
  }
  const start = initialPrototype(doc)
  expect(start.current).toBe(from.id)
  const played = prototypeEvent(doc, start, spot.id, 'click')
  expect(played.current).toBe(to.id)
  expect(played.transitionMs).toBe(300)
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
