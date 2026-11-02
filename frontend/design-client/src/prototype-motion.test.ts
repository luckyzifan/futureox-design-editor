import { expect, test } from 'vitest'
import { validatePrototype } from './automation/interactions'
import { Editor } from './engine'
import { blank, effect, node, paint } from './model'
import { initialPrototype, prototypeEvent } from './prototype'
import { framesNeedLightweightMotion, lightenPrototypeMotion, PROTOTYPE_MOTION_CAPS, resolvePrototypeMotion, startTransitionClock } from './prototype-motion'

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

test('adding a 300ms ease-out interaction on a blank document is admitted', () => {
  const doc = blank()
  const frame = node('frame', 0, 0, 100, 80)
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  const result = editor.change('添加交互', (draft) => {
    draft.prototype ??= { interactions: {} }
    ;(draft.prototype.interactions[frame.id] ??= []).push({
      trigger: 'click',
      actions: [{ kind: 'navigate', target: frame.id, durationMs: 300, easingCurve: 'ease-out' }],
    })
  })
  expect(result?.status).toBe('committed')
  expect(editor.state.doc.schemaVersion).toBeGreaterThanOrEqual(12)
  expect(editor.state.doc.prototype?.interactions[frame.id][0].actions[0]).toMatchObject({
    durationMs: 300,
    easingCurve: 'ease-out',
  })
  editor.dispose()
})

test('omitted prototype motion uses 300ms ease-out and an explicit zero stays instant', () => {
  expect(resolvePrototypeMotion({ kind: 'navigate', target: 'a' }, undefined, undefined)).toEqual({ durationMs: 300, easing: 'ease-out' })
  expect(resolvePrototypeMotion({ kind: 'navigate', target: 'a', transitionStyle: 'none' }, undefined, undefined).durationMs).toBe(0)
  expect(resolvePrototypeMotion({ kind: 'navigate', target: 'a', durationMs: 0 }, 0, undefined).durationMs).toBe(0)
  const doc = blank()
  const from = node('frame', 0, 0, 80, 80)
  const to = node('frame', 120, 0, 80, 80)
  doc.nodes[from.id] = from
  doc.nodes[to.id] = to
  doc.pages[0].children = [from.id, to.id]
  doc.prototype = { interactions: { [from.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: to.id }] }] } }
  const state = prototypeEvent(doc, initialPrototype(doc), from.id, 'click')
  expect(state.transitionMs).toBe(300)
  expect(state.transitionEasing).toBe('ease-out')
  expect(state.current).toBe(to.id)
})

test('angular and diamond paints skip per-tick sampling; capped glass and blur do not', () => {
  const doc = blank()
  const plain = node('frame', 0, 0, 40, 40)
  const glassy = node('frame', 80, 0, 40, 40)
  glassy.effects = [effect('glass')]
  const blurred = node('rectangle', 0, 0, 10, 10)
  blurred.effects = [effect('blur')]
  glassy.children = [blurred.id]
  const shadow = node('frame', 160, 0, 40, 40)
  shadow.effects = [effect('shadow')]
  const angular = node('rectangle', 0, 0, 10, 10)
  angular.fills = [{ ...paint('#3459d4', 'angular'), stops: [{ offset: 0, color: '#3459d4' }, { offset: 1, color: '#ffffff' }] }]
  doc.nodes[plain.id] = plain
  doc.nodes[glassy.id] = glassy
  doc.nodes[blurred.id] = blurred
  doc.nodes[shadow.id] = shadow
  doc.nodes[angular.id] = angular
  expect(framesNeedLightweightMotion(doc, plain.id, plain.id)).toBe(false)
  expect(framesNeedLightweightMotion(doc, plain.id, glassy.id)).toBe(false)
  expect(framesNeedLightweightMotion(doc, shadow.id, plain.id)).toBe(false)
  expect(framesNeedLightweightMotion(doc, angular.id, plain.id)).toBe(true)
})

test('a cancelled transition clock does not deliver a later tick', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  const clock = {
    now: () => 0,
    request: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id },
    cancel: (handle: number) => { frames.delete(handle) },
  }
  const seen: number[] = []
  const queued = () => frames.get(1)
  const cancel = startTransitionClock(300, value => { seen.push(value) }, clock)
  const tick = queued()
  expect(tick).toBeTypeOf('function')
  cancel()
  tick?.(300)
  expect(seen).toEqual([])
  expect(frames.size).toBe(0)
})
