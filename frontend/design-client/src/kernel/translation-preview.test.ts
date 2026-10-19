import { expect, test } from 'vitest'
import { blank, node, defaultLayout, defaultSizing, type DesignDocument, type DesignNode } from '../model'
import { emptySystem } from '../design-system'
import { translationOnlyChanges } from './translation-preview'

function fixture() {
  const document = blank()
  const parent = node('frame', 0, 0, 300, 200)
  const moving = node('group', 20, 30, 40, 50)
  const other = node('vector', 200, 100, 20, 20)
  other.booleanOperation = 'subtract'
  parent.children = [moving.id]
  document.nodes = { [parent.id]: parent, [moving.id]: moving, [other.id]: other }
  document.pages[0].children = [parent.id, other.id]
  document.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: { [moving.id]: { source: true } } } }
  const translated = (source = document): DesignDocument => ({ ...source, nodes: { ...source.nodes,
    [moving.id]: { ...source.nodes[moving.id], transform: [1, 0, 0, 1, 25, 37] } } })
  return { document, parent, moving, other, translated }
}

test('placement reuse accepts opaque metadata and retains unrelated resolved boolean nodes', () => {
  const { document, moving, other, translated } = fixture()
  const after = translated()
  expect(translationOnlyChanges(document, after)).toEqual([moving.id])
  expect(after.nodes[other.id]).toBe(document.nodes[other.id])
  expect(after.designSystem).toBe(document.designSystem)
})

test('a no-op immutable node map needs no resolver', () => {
  const { document } = fixture()
  expect(translationOnlyChanges(document, { ...document, nodes: { ...document.nodes } })).toEqual([])
})

test.each(['width', 'height', 'children', 'text', 'fontSize', 'textStyle', 'network', 'opacity', 'extension'])(
  'any non-placement node change falls back: %s', field => {
    const { document, moving, translated } = fixture()
    const after = translated()
    const value: Record<string, unknown> = { width: 41, height: 51, children: [], text: 'changed',
      fontSize: 29, textStyle: {}, network: {}, opacity: 0.5, extension: { future: true } }
    Object.assign(after.nodes[moving.id], { [field]: value[field] })
    expect(translationOnlyChanges(document, after)).toBeNull()
  })

test.each([[2, 0, 0, 1, 25, 37], [1, 0.1, 0, 1, 25, 37], [1, 0, 0, 1, NaN, 37], [1, 0, 0, 1, Infinity, 37]])(
  'linear transform changes and invalid coordinates fall back: %j', (...matrix) => {
    const { document, moving, translated } = fixture()
    const after = translated()
    after.nodes[moving.id].transform = matrix as DesignNode['transform']
    expect(translationOnlyChanges(document, after)).toBeNull()
  })

test.each(['pages', 'fonts', 'designSystem', 'prototype', 'schemaVersion', 'id'])(
  'document/resource/semantic identities must remain stable: %s', field => {
    const { document, translated } = fixture()
    const after = translated()
    Object.assign(after, { [field]: field === 'schemaVersion' ? 12 : field === 'id' ? 'other' : {} })
    expect(translationOnlyChanges(document, after)).toBeNull()
  })

test.each(['component', 'componentSet', 'componentKey', 'instance', 'instanceOrigin', 'bindings', 'styleRefs',
  'variableModes', 'booleanOperation', 'constraints', 'layout', 'sizing'])(
  'moving nodes or ancestors with dependencies fall back: %s', field => {
    for (const target of ['moving', 'parent'] as const) {
      const data = fixture()
      const value: Record<string, unknown> = { component: {}, componentSet: true, componentKey: 'c', instance: {},
        instanceOrigin: {}, bindings: { width: 'v' }, styleRefs: { fills: 's' }, variableModes: { c: 'mode' },
        booleanOperation: 'subtract', constraints: { horizontal: 'scale', vertical: 'scale' },
        layout: { ...defaultLayout(), mode: 'horizontal' }, sizing: { ...defaultSizing(), width: 'hug' } }
      Object.assign(data.document.nodes[data[target].id], { [field]: value[field] })
      expect(translationOnlyChanges(data.document, data.translated())).toBeNull()
    }
  })

test('reparent, node-set changes, parent resize, connectors and animations fall back', () => {
  for (const variant of ['reparent', 'insert', 'parentResize', 'connector', 'code', 'animation']) {
    const { document, parent, other, translated } = fixture()
    if (variant === 'connector') other.connector = { from: { point: { x: 0, y: 0 } }, to: { point: { x: 1, y: 1 } }, style: 'straight' }
    if (variant === 'code') other.board = { kind: 'code-block', language: 'rust' }
    if (variant === 'animation') Object.assign(document, { animations: [{}] })
    const after = translated()
    if (variant === 'reparent') after.nodes[parent.id] = { ...parent, children: [] }
    if (variant === 'parentResize') after.nodes[parent.id] = { ...parent, width: 400 }
    if (variant === 'insert') { const added = node('rectangle', 0, 0, 5, 5); after.nodes[added.id] = added }
    expect(translationOnlyChanges(document, after)).toBeNull()
  }
})
