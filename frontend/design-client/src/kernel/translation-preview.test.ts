import { expect, test } from 'vitest'
import { blank, node, defaultLayout, defaultSizing, type DesignDocument, type DesignNode } from '../model'
import { emptySystem } from '../design-system'
import { translationOnlyChanges, TranslationPreviewPlan } from './translation-preview'

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

test('transaction translation plans retain the same exact constraint and dependency decisions',()=>{
 for(const horizontal of ['start','center','end','stretch','scale'] as const)for(const x of [-0,0,.125,-100,1e7]){
  const {document,moving,translated}=fixture();moving.constraints={horizontal,vertical:'center',referenceWidth:300,referenceHeight:200}
  const after=translated();after.nodes[moving.id].transform=[1,0,0,1,x,37]
  const ids=[moving.id],plan=new TranslationPreviewPlan(document,ids);ids.length=0
  expect(plan.accepts({[moving.id]:{transform:after.nodes[moving.id].transform}})).toBe(translationOnlyChanges(document,after)!==null)
 }
 const {document,moving}=fixture();moving.instance={componentId:'source',overrides:{},propertyValues:{}}
 expect(new TranslationPreviewPlan(document,[moving.id]).accepts({[moving.id]:{transform:[1,0,0,1,2,3]}})).toBe(false)
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
  'variableModes', 'booleanOperation', 'layout', 'sizing'])(
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

test('reparent, node-set changes, parent resize, attached connectors and animations fall back', () => {
  for (const variant of ['reparent', 'insert', 'parentResize', 'connector', 'animation']) {
    const { document, parent, moving, other, translated } = fixture()
    if (variant === 'connector') other.connector = { from: { point: { x: 0, y: 0 }, nodeId: moving.id, anchor: { x: 0, y: 0 } }, to: { point: { x: 1, y: 1 } }, style: 'straight' }
    if (variant === 'animation') Object.assign(document, { animations: [{}] })
    const after = translated()
    if (variant === 'reparent') after.nodes[parent.id] = { ...parent, children: [] }
    if (variant === 'parentResize') after.nodes[parent.id] = { ...parent, width: 400 }
    if (variant === 'insert') { const added = node('rectangle', 0, 0, 5, 5); after.nodes[added.id] = added }
    expect(translationOnlyChanges(document, after)).toBeNull()
  }
})

test('a connector or code block on another node does not reject a placement-only edit', () => {
  const { document, moving, other, translated } = fixture()
  other.connector = { from: { point: { x: 0, y: 0 } }, to: { point: { x: 1, y: 1 } }, style: 'straight' }
  other.board = { kind: 'code-block', language: 'rust' }
  expect(translationOnlyChanges(document, translated())).toEqual([moving.id])
})

test.each(['start', 'center', 'end', 'stretch', 'scale'] as const)('constraints admit only exact per-axis fixed points: %s', mode => {
  const f = fixture()
  f.moving.constraints = { horizontal: mode, vertical: mode, referenceWidth: 300, referenceHeight: 200 }
  expect(translationOnlyChanges(f.document, f.translated())).toEqual([f.moving.id])
})

test('missing/mismatched references, rounding and signed zero keep full resolution', () => {
  for (const variant of ['missing', 'mismatch', 'end-rounding', 'negative-zero']) {
    const f = fixture()
    f.moving.constraints = { horizontal: 'end', vertical: 'center', referenceWidth: 300, referenceHeight: 200 }
    if (variant === 'missing') delete f.moving.constraints.referenceWidth
    if (variant === 'mismatch') f.moving.constraints.referenceWidth = 299
    if (variant === 'end-rounding') { f.parent.width = 1e7; f.moving.constraints.referenceWidth = 1e7 }
    const after = f.translated()
    if (variant === 'end-rounding') after.nodes[f.moving.id].transform[4] = 0.1
    if (variant === 'negative-zero') after.nodes[f.moving.id].transform[4] = -0
    expect(translationOnlyChanges(f.document, after)).toBeNull()
  }
})

test('constraints on an actual page root are inert while orphans remain inadmissible', () => {
  const f = fixture()
  f.parent.constraints = { horizontal: 'scale', vertical: 'scale' }
  expect(translationOnlyChanges(f.document, f.translated())).toEqual([f.moving.id])
  f.document.pages[0].children = []
  expect(translationOnlyChanges(f.document, f.translated())).toBeNull()
})
