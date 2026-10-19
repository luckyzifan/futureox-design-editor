import assert from 'node:assert/strict'
import test from 'node:test'
import { pageHasFilteredContent } from './canvas-effect-sampling.ts'

const node = (id, patch = {}) => ({ id, visible: true, children: [], effects: [], ...patch })
const effect = (kind = 'shadow', visible = true) => ({ kind, visible })
const document = nodes => ({
  nodes: Object.fromEntries(nodes.map(value => [value.id, value])),
  pages: [{ id: 'current', children: ['root'] }, { id: 'other', children: ['other-root'] }],
})

test('other-page effects do not disable the current page reusable zoom density', () => {
  const doc = document([node('root'), node('other-root', { effects: [effect()] })])
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
  assert.equal(pageHasFilteredContent(doc, 'other'), true)
})

test('detached effect definitions do not change page sampling', () => {
  assert.equal(pageHasFilteredContent(document([node('root'), node('detached', { effects: [effect()] })]), 'current'), false)
})

test('hidden nodes and the complete subtree of hidden ancestors do not change page sampling', () => {
  const doc = document([
    node('root', { children: ['hidden', 'hidden-parent'] }),
    node('hidden', { visible: false, effects: [effect()] }),
    node('hidden-parent', { visible: false, children: ['visible-child'] }),
    node('visible-child', { effects: [effect('blur')] }),
  ])
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
  doc.nodes['hidden-parent'].visible = true
  assert.equal(pageHasFilteredContent(doc, 'current'), true)
})

test('each visible filtering effect in nested page content preserves native-density scheduling', () => {
  for (const kind of ['blur', 'background-blur', 'shadow', 'inner-shadow', 'glass']) {
    const doc = document([node('root', { children: ['nested'] }), node('nested', { effects: [effect(kind)] })])
    assert.equal(pageHasFilteredContent(doc, 'current'), true, kind)
  }
})

test('disabled effects and unrelated material effects keep existing sampling eligibility', () => {
  const doc = document([node('root', { effects: [effect('shadow', false), effect('noise'), effect('texture')] })])
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
})

test('offscreen effects remain conservative because shadow and blur support can reach the viewport', () => {
  const doc = document([node('root', { transform: [1, 0, 0, 1, 100000, 100000], effects: [effect()] })])
  assert.equal(pageHasFilteredContent(doc, 'current'), true)
})

test('unknown pages and missing child references are harmless', () => {
  const doc = document([node('root', { children: ['missing'] })])
  assert.equal(pageHasFilteredContent(doc, 'missing'), false)
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
})

test('shared descendants and malformed cycles cannot cause unbounded traversal', () => {
  const doc = document([node('root', { children: ['child', 'child'] }), node('child', { children: ['root'] })])
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
  doc.nodes.child.effects = [effect()]
  assert.equal(pageHasFilteredContent(doc, 'current'), true)
})


test('visible instances retain exact scheduling even with no authored children', () => {
  const doc = document([node('root', { instance: { componentId: 'detached-component' } }),
    node('detached-component', { effects: [effect('blur')] })])
  assert.equal(pageHasFilteredContent(doc, 'current'), true)
})
test('shared styles retain exact scheduling before kernel effect resolution', () => {
  const doc = document([node('root', { styleRefs: { effects: 'shared-effects' } })])
  assert.equal(pageHasFilteredContent(doc, 'current'), true)
})
test('hidden instances and style references do not affect visible page content', () => {
  const doc = document([node('root', { children: ['instance', 'styled'] }),
    node('instance', { visible: false, instance: { componentId: 'master' } }),
    node('styled', { visible: false, styleRefs: { effects: 'shared' } })])
  assert.equal(pageHasFilteredContent(doc, 'current'), false)
})
