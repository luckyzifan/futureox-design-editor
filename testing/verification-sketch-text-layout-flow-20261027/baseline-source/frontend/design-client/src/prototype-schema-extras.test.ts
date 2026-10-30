import { expect, test } from 'vitest'
import { blank, node, validateDocument } from './model'
import {
  hasSchemaExtras,
  initialPrototype,
  prototypeEvent,
  type PrototypeAction,
} from './prototype'

const extras: Partial<PrototypeAction> = {
  targetVariable: 'var-1',
  targetVariableModeId: 'mode-1',
  targetVariableSetId: 'set-1',
  targetVariableSetKey: 'set-key',
  targetVariableData: { id: 'var-1', modeId: 'mode-1', future: 1 },
  mediaAction: 'toggle',
  mediaSkipByAmount: 2.5,
  mediaSkipToTime: 12,
  transitionShouldSmartAnimate: true,
  transitionOverridesEnabled: false,
  transitionPreserveScroll: true,
  transitionResetScrollPosition: false,
  transitionResetInteractiveComponents: true,
  transitionDurationVar: 'var-dur',
  transitionEasingVar: 'var-ease',
}

test('recovered action-schema fields round-trip the document JSON losslessly', () => {
  const d = blank()
  d.schemaVersion = 12
  const a = node('frame', 0, 0, 100, 100),
    b = node('frame', 120, 0, 100, 100)
  d.nodes[a.id] = a
  d.nodes[b.id] = b
  d.pages[0].children = [a.id, b.id]
  d.prototype = {
    interactions: {
      [a.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: b.id, ...extras }] }],
    },
  }
  const loaded = validateDocument(JSON.parse(JSON.stringify(d)))
  const action = loaded.prototype!.interactions[a.id][0].actions[0]
  expect(action).toEqual({ kind: 'navigate', target: b.id, ...extras })
  expect(hasSchemaExtras(action)).toBe(true)
  // Unsupported playback must report the missing capability, while keeping
  // the imported metadata intact for a later capable player.
  expect(() => prototypeEvent(loaded, initialPrototype(loaded), a.id, 'click')).toThrow('媒体播放动作')
  expect(loaded.prototype!.interactions[a.id][0].actions[0]).toEqual(action)
})

test('hasSchemaExtras mirrors the kernel gate', () => {
  expect(hasSchemaExtras({ kind: 'back' })).toBe(false)
  expect(hasSchemaExtras({ kind: 'back', mediaSkipByAmount: 0 })).toBe(true)
  expect(hasSchemaExtras({ kind: 'back', transitionPreserveScroll: false })).toBe(true)
  expect(hasSchemaExtras({ kind: 'navigate', target: 'x', durationMs: 100 })).toBe(false)
})
