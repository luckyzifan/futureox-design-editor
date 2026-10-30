import { describe, expect, it } from 'vitest'
import { blank, defaultTextStyle, effect, node, paint, stroke, type DesignDocument } from '../model'
import * as Components from '../components'
import { emptySystem } from '../design-system'
import { initialPrototype, prototypeEvent } from '../prototype'
import { applyDesignSystemOperation, designSystemExtensions, validateDesignSystemDocument } from './design-system'
import { Editor } from '../engine'
import { createDesignAutomation } from './core'
import { readFileSync } from 'node:fs'

// Original minimal test-only SFNT generated with FontBuilder; no OS font access.
const testFont = 'AAEAAAAKAIAAAwAgT1MvMmUdmiEAAAEoAAAAYGNtYXAGO07YAAABlAAAAERnbHlm1FbUUgAAAeQAAABoaGVhZC8xsWIAAACsAAAANmhoZWEEgAKMAAAA5AAAACRobXR4AlgAAAAAAYgAAAAKbG9jYQBOADQAAAHYAAAACm1heHAABgAGAAABCAAAACBuYW1l6XaEXgAAAkwAAAFHcG9zdEGRzTYAAAOUAAAANQABAAAAAQAAY20Tj18PPPUAAQPoAAAAAOb7tuMAAAAA5vu24wBkAAABwgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYAAAA+gFeAAEAAAAAAAAAAAAAAAAAAAABAAEAAAAEAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACABCAAAAAAAAAAAAAAAPz8/PwAAAEFOLQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAAAAAAAAAAAAAAAACAAAAAwAAABQAAwABAAAAFAAEADAAAAAIAAgAAgAAAEEGJ04t//8AAABBBidOLf///8D527HWAAEAAAAAAAAAAAAAAA0AGgAnADQAAAABAGQAAAHCArwAAwAAMyERIWQBXv6iArwAAAEAZAAAAcICvAADAAAzIREhZAFe/qICvAAAAQBkAAABwgK8AAMAADMhESFkAV7+ogK8AAABAGQAAAHCArwAAwAAMyERIWQBXv6iArwAAAAACgB+AAEAAAAAAAEADwAAAAEAAAAAAAIABwAPAAEAAAAAAAMAFgAWAAEAAAAAAAQAFwAsAAEAAAAAAAYAFgAWAAMAAQQJAAEAHgBDAAMAAQQJAAIADgBhAAMAAQQJAAMALABvAAMAAQQJAAQALgCbAAMAAQQJAAYALABvQXV0b21hdGlvbiBUZXN0UmVndWxhckF1dG9tYXRpb25UZXN0LVJlZ3VsYXJBdXRvbWF0aW9uIFRlc3QgUmVndWxhcgBBAHUAdABvAG0AYQB0AGkAbwBuACAAVABlAHMAdABSAGUAZwB1AGwAYQByAEEAdQB0AG8AbQBhAHQAaQBvAG4AVABlAHMAdAAtAFIAZQBnAHUAbABhAHIAQQB1AHQAbwBtAGEAdABpAG8AbgAgAFQAZQBzAHQAIABSAGUAZwB1AGwAYQByAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAkAQIBAwZhcmFiaWMDY2prAAAA'

function fixture() {
  const d = blank('Automation design system'), frame = node('frame'), text = node('text'), shape = node('rectangle')
  frame.children = [text.id, shape.id]
  text.name = 'Label'; text.text = 'Button'; text.textStyle = defaultTextStyle()
  d.nodes = { [frame.id]: frame, [text.id]: text, [shape.id]: shape }
  d.pages[0].children = [frame.id]
  return { d, frame, text, shape }
}
function resources() {
  const { d, ...nodes } = fixture()
  d.schemaVersion = 6
  d.designSystem = emptySystem()
  d.designSystem.collections.theme = { name: 'Theme', modes: ['Light', 'Dark'], defaultMode: 'Light' }
  d.designSystem.activeModes.theme = 'Light'
  d.designSystem.variables.brand = { name: 'Brand', kind: 'color', collection: 'theme', values: { Light: '#123456', Dark: '#abcdef' } }
  d.designSystem.variables.spacing = { name: 'Spacing', kind: 'number', collection: 'theme', values: { Light: 8, Dark: 16 } }
  d.designSystem.styles.fill = { name: 'Brand paint', kind: 'paint', value: [paint('#123456')] }
  return { d, ...nodes }
}
function mainFixture() {
  const f = fixture()
  Components.createMain(f.d, [f.frame.id], f.d.pages[0].id)
  const id = Components.insertInstance(f.d, f.frame.id, f.d.pages[0].id, { x: 100, y: 200 })
  return { ...f, instanceId: id }
}
function apply(d: DesignDocument, method: string, p: Record<string, unknown> = {}) {
  return applyDesignSystemOperation(d, method, p)
}
function resultId(r: ReturnType<typeof apply>) { return (r.result as { id: string }).id }

describe('design-system automation metadata and atomic boundary', () => {
  it('exposes unique schema-described local operations without publishing claims', () => {
    const names = designSystemExtensions.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(35)
    expect(names.some(n => /publish|remote|cloud/.test(n))).toBe(false)
    for (const e of designSystemExtensions) expect(e.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
  })
  it('never mutates the input document or returned reads through aliases', () => {
    const { d } = resources(), before = structuredClone(d)
    const next = apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: 32 })
    expect(d).toEqual(before)
    expect(next.document.designSystem!.variables.spacing.values.Dark).toBe(32)
    const read = apply(d, 'variable.get', { variableId: 'brand' }).result as { values: Record<string, string> }
    read.values.Light = '#ffffff'
    expect(d.designSystem!.variables.brand.values.Light).toBe('#123456')
  })
  it('rolls back invalid mutations and rejects unknown methods and parameters', () => {
    const { d } = resources(), before = structuredClone(d)
    expect(() => apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: 'bad' })).toThrow()
    expect(d).toEqual(before)
    expect(() => apply(d, 'library.publish')).toThrow(/Unknown/)
    expect(() => apply(d, 'collection.create', { name: 'Theme', surprise: true })).toThrow(/Unknown parameter/)
    expect(() => apply(d, 'variable.get')).toThrow(/Missing parameter/)
  })
  it('rejects unknown IDs, duplicates, reserved keys, and nonfinite input', () => {
    const { d, frame } = resources()
    expect(() => apply(d, 'variable.get', { variableId: 'missing' })).toThrow(/Unknown variable/)
    expect(() => apply(d, 'collection.create', { id: 'theme', name: 'Duplicate' })).toThrow(/exists/)
    expect(() => apply(d, 'collection.create', { id: '__proto__', name: 'Unsafe' })).toThrow(/Invalid/)
    expect(() => apply(d, 'collection.create', { name: 'Modes', modes: ['A', 'A'] })).toThrow(/duplicate/)
    expect(() => apply(d, 'component.create', { nodeIds: [frame.id, frame.id] })).toThrow(/duplicate/)
    expect(() => apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Light', value: Infinity })).toThrow(/Invalid/)
  })
})

describe('component operations', () => {
  it('respects own and ancestor locks when creating, inserting, detaching and swapping', () => {
    const basic = fixture()
    basic.shape.locked = true
    expect(() => apply(basic.d, 'component.create', { nodeIds: [basic.shape.id] })).toThrow(/locked/)
    basic.shape.locked = false; basic.frame.locked = true
    expect(() => apply(basic.d, 'component.create', { nodeIds: [basic.shape.id] })).toThrow(/locked/)
    const { d, frame, instanceId } = mainFixture(), parent = node('frame')
    parent.children = [instanceId]; parent.locked = true
    d.nodes[parent.id] = parent
    d.pages[0].children = d.pages[0].children.filter(id => id !== instanceId).concat(parent.id)
    const before = structuredClone(d)
    expect(() => apply(d, 'component.instantiate', { componentId: frame.id, parentId: parent.id })).toThrow(/locked/)
    expect(() => apply(d, 'component.detach', { nodeId: instanceId })).toThrow(/locked/)
    expect(() => apply(d, 'component.swap', { nodeId: instanceId, componentId: frame.id })).toThrow(/locked/)
    expect(d).toEqual(before)
    parent.locked = false; d.nodes[instanceId].locked = true
    expect(() => apply(d, 'component.swap', { nodeId: instanceId, componentId: frame.id })).toThrow(/locked/)
    frame.locked = true
    // Reading a locked definition remains allowed when inserting elsewhere.
    expect(apply(d, 'component.instantiate', { componentId: frame.id }).createdIds).toHaveLength(1)
  })
  it('respects variant-structure locks while preserving explicit property-panel edits', () => {
    const { d, frame, instanceId, text } = mainFixture()
    frame.locked = true
    expect(() => apply(d, 'component.addVariant', { componentId: frame.id })).toThrow(/locked/)
    expect(() => apply(d, 'component.combineVariants', { componentIds: [frame.id] })).toThrow(/locked/)
    frame.locked = false
    const added = apply(d, 'component.addVariant', { componentId: frame.id }).document
    const set = Object.values(added.nodes).find(n => n.componentSet)!
    set.locked = true
    expect(() => apply(added, 'component.addVariant', { componentId: frame.id })).toThrow(/locked/)
    expect(() => apply(added, 'component.addVariantAxis', { setId: set.id, name: 'Size' })).toThrow(/locked/)
    set.locked = false; added.nodes[frame.id].locked = true
    expect(() => apply(added, 'component.addVariantAxis', { setId: set.id, name: 'Size' })).toThrow(/locked/)
    added.nodes[instanceId].locked = true
    expect(() => apply(added, 'component.switchVariant', { nodeId: instanceId, axis: '状态', value: '默认' })).toThrow(/locked/)
    expect(apply(added, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { text: 'Explicit property edit' } }).document.nodes[instanceId].instance!.overrides[text.id].text).toBe('Explicit property edit')
  })
  it('reports locked_node through the actual API without state or history changes', () => {
    const { d, frame, shape } = fixture(); frame.locked = true
    const editor = new Editor(d)
    try {
      const before = editor.state.doc, api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument])
      const response = api.execute({ method: 'component.create', params: { nodeIds: [shape.id] }, documentId: d.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('locked_node')
      expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    } finally { editor.dispose() }
  })
  it('creates a main component from a leaf without modifying input and instantiates it', () => {
    const { d, shape } = fixture()
    const made = apply(d, 'component.create', { nodeIds: [shape.id], name: 'Icon' }), id = resultId(made)
    expect(made.document.nodes[id].component).toEqual({ properties: {}, variants: {} })
    expect(made.document.nodes[id].name).toBe('Icon')
    expect(made.document.nodes[id].children).toEqual([shape.id])
    expect(d.nodes[shape.id].component).toBeUndefined()
    const inserted = apply(made.document, 'component.instantiate', { componentId: id, x: 12, y: 24 })
    expect(inserted.document.nodes[resultId(inserted)].instance?.componentId).toBe(id)
    expect(inserted.document.nodes[resultId(inserted)].transform).toEqual([1, 0, 0, 1, 12, 24])
    expect(inserted.createdIds).toEqual([resultId(inserted)])
  })
  it('defines text/boolean properties and applies typed values', () => {
    const { d, frame, text, shape, instanceId } = mainFixture()
    const defined = apply(d, 'component.defineProperty', { nodeId: text.id, kind: 'text', name: 'Label' })
    const propertyId = (defined.result as { propertyId: string }).propertyId
    const set = apply(defined.document, 'component.setProperty', { nodeId: instanceId, propertyId, value: 'Continue' })
    expect(set.document.nodes[instanceId].instance!.propertyValues[propertyId]).toBe('Continue')
    expect(() => apply(set.document, 'component.setProperty', { nodeId: instanceId, propertyId, value: false })).toThrow(/string/)
    expect(() => apply(set.document, 'component.setProperty', { nodeId: instanceId, propertyId: 'missing', value: 'X' })).toThrow(/Unknown property/)
    expect(() => apply(d, 'component.defineProperty', { nodeId: shape.id, kind: 'text', name: 'Wrong' })).toThrow(/text layer/)
    expect(() => apply(d, 'component.defineProperty', { nodeId: frame.id, kind: 'boolean', name: 'Root' })).toThrow()
    const visible = apply(set.document, 'component.defineProperty', { nodeId: shape.id, kind: 'boolean', name: 'Icon visible' })
    expect(Object.values(visible.document.nodes[frame.id].component!.properties).some(p => p.kind === 'boolean')).toBe(true)
  })
  it('rejects duplicate property names and duplicate bindings', () => {
    const { d, text, shape } = mainFixture()
    const once = apply(d, 'component.defineProperty', { nodeId: text.id, kind: 'text', name: 'Label' }).document
    expect(() => apply(once, 'component.defineProperty', { nodeId: shape.id, kind: 'boolean', name: 'Label' })).toThrow()
    expect(() => apply(once, 'component.defineProperty', { nodeId: text.id, kind: 'text', name: 'Label again' })).toThrow(/duplicate/)
  })
  it('validates override targets, values, and structural prohibitions', () => {
    const { d, text, instanceId } = mainFixture()
    const changed = apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { text: 'Override', opacity: 0.5 } })
    expect(changed.document.nodes[instanceId].instance!.overrides[text.id]).toEqual({ text: 'Override', opacity: 0.5 })
    expect(() => apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: 'missing', values: { text: 'X' } })).toThrow(/Unknown override target/)
    expect(() => apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { children: [] } })).toThrow(/Structural/)
    expect(() => apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { opacity: 2 } })).toThrow()
    const cleared = apply(changed.document, 'component.clearOverride', { nodeId: instanceId, targetKey: text.id, fields: ['text'] })
    expect(cleared.document.nodes[instanceId].instance!.overrides[text.id]).toEqual({ opacity: 0.5 })
    const reset = apply(changed.document, 'component.reset', { nodeId: instanceId })
    expect(reset.document.nodes[instanceId].instance!.overrides).toEqual({})
  })
  it('validates overrides using resources rather than accepting dangling bindings', () => {
    const { d, text, instanceId } = mainFixture()
    expect(() => apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { bindings: { opacity: 'missing' } } })).toThrow(/Unknown variable/)
    expect(() => apply(d, 'component.setOverride', { nodeId: instanceId, targetKey: text.id, values: { styleRefs: { fills: 'missing' } } })).toThrow(/Unknown style/)
  })
  it('resolves nested override targets after property-driven swaps before materialization', () => {
    const { d, frame } = mainFixture(), alternate = node('frame'), label = node('text'), outer = node('frame')
    alternate.children = [label.id]
    d.nodes[alternate.id] = alternate; d.nodes[label.id] = label; d.nodes[outer.id] = outer
    d.pages[0].children.push(alternate.id, outer.id)
    Components.createMain(d, [alternate.id], d.pages[0].id)
    Components.createMain(d, [outer.id], d.pages[0].id)
    const nested = Components.insertInstance(d, frame.id, d.pages[0].id, { x: 0, y: 0 }, outer.id)
    const defined = apply(d, 'component.defineProperty', { nodeId: nested, kind: 'instance-swap', name: 'Content' })
    const propertyId = (defined.result as { propertyId: string }).propertyId
    const inserted = apply(defined.document, 'component.instantiate', { componentId: outer.id }), owner = resultId(inserted)
    const swapped = apply(inserted.document, 'component.setProperty', { nodeId: owner, propertyId, value: alternate.id })
    const targetKey = `${nested}/${label.id}`
    const overridden = apply(swapped.document, 'component.setOverride', { nodeId: owner, targetKey, values: { text: 'Nested replacement' } })
    expect(overridden.document.nodes[owner].instance!.overrides[targetKey]).toEqual({ text: 'Nested replacement' })
  })
  it('keeps component template dependency cycles out of valid layer trees', () => {
    const { d, frame } = mainFixture(), before = structuredClone(d)
    expect(() => apply(d, 'component.instantiate', { componentId: frame.id, parentId: frame.id })).toThrow(/Cyclic component/)
    expect(d).toEqual(before)
    const second = node('frame'); d.nodes[second.id] = second; d.pages[0].children.push(second.id)
    Components.createMain(d, [second.id], d.pages[0].id)
    Components.insertInstance(d, second.id, d.pages[0].id, { x: 0, y: 0 }, frame.id)
    expect(() => apply(d, 'component.instantiate', { componentId: frame.id, parentId: second.id })).toThrow(/Cyclic component/)
  })
  it('combines/adds/switches variants and rejects duplicate combinations', () => {
    const { d, frame, instanceId } = mainFixture()
    const added = apply(d, 'component.addVariant', { componentId: frame.id }), other = resultId(added)
    const set = Object.values(added.document.nodes).find(n => n.componentSet)!
    expect(set.children).toEqual([frame.id, other])
    const axis = Object.keys(added.document.nodes[other].component!.variants)[0]
    const value = added.document.nodes[other].component!.variants[axis]
    const switched = apply(added.document, 'component.switchVariant', { nodeId: instanceId, axis, value })
    expect(switched.document.nodes[instanceId].instance!.componentId).toBe(other)
    expect(() => apply(added.document, 'component.setVariants', { componentId: other, variants: added.document.nodes[frame.id].component!.variants })).toThrow(/unique/)
    const extra = apply(added.document, 'component.addVariantAxis', { setId: set.id, name: 'Size', defaultValue: 'Medium' })
    expect(extra.document.nodes[other].component!.variants.Size).toBe('Medium')
    expect(() => apply(extra.document, 'component.addVariantAxis', { setId: set.id, name: 'Size' })).toThrow(/exists/)
  })
  it('remaps swapped properties by matching names and kinds', () => {
    const { d, frame, text, instanceId } = mainFixture()
    const defined = apply(d, 'component.defineProperty', { nodeId: text.id, kind: 'text', name: 'Label' })
    const propertyId = (defined.result as { propertyId: string }).propertyId
    const set = apply(defined.document, 'component.setProperty', { nodeId: instanceId, propertyId, value: 'Custom' })
    const added = apply(set.document, 'component.addVariant', { componentId: frame.id }), id = resultId(added)
    const swapped = apply(added.document, 'component.swap', { nodeId: instanceId, componentId: id })
    expect(swapped.document.nodes[instanceId].instance!.componentId).toBe(id)
    expect(Object.values(swapped.document.nodes[instanceId].instance!.propertyValues)).toContain('Custom')
  })
  it('detaches materialized children and preserves their concrete values', () => {
    const { d, text, instanceId } = mainFixture()
    const child = structuredClone(text); child.id = crypto.randomUUID(); child.text = 'Customized'
    child.instanceOrigin = { owner: instanceId, key: text.id, source: text.id }
    d.nodes[child.id] = child; d.nodes[instanceId].children = [child.id]
    const detached = apply(d, 'component.detach', { nodeId: instanceId })
    expect(detached.document.nodes[instanceId].instance).toBeUndefined()
    expect(detached.document.nodes[child.id].instanceOrigin).toBeUndefined()
    expect(detached.document.nodes[child.id].text).toBe('Customized')
    expect(d.nodes[instanceId].instance).toBeDefined()
  })
  it('rejects unsafe unmaterialized detach and unknown or invalid instance parents', () => {
    const { d, frame, text, instanceId } = mainFixture()
    expect(() => apply(d, 'component.detach', { nodeId: instanceId })).toThrow(/resolved/)
    expect(() => apply(d, 'component.instantiate', { componentId: frame.id, parentId: text.id })).toThrow(/parent/)
    expect(() => apply(d, 'component.instantiate', { componentId: frame.id, x: NaN })).toThrow(/Invalid x/)
    expect(() => apply(d, 'component.swap', { nodeId: instanceId, componentId: 'missing' })).toThrow(/Unknown node/)
  })
})

describe('collections and variables', () => {
  it('renames prototype action modes atomically without touching another collection', () => {
    const { d, shape } = resources(); d.schemaVersion = 12
    d.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
    d.designSystem!.variables.otherNumber = { name: 'Other number', collection: 'other', kind: 'number', values: { Light: 1, Dark: 2 } }
    d.prototype = { interactions: { [shape.id]: [{ trigger: 'click', actions: [
      { kind: 'set-variable', target: 'spacing', value: 12, targetVariable: 'spacing', targetVariableModeId: 'Dark', targetVariableData: { id: 'spacing', modeId: 'Dark' } },
      { kind: 'set-variable', target: 'spacing', value: 13, targetVariableData: { id: 'spacing', modeId: 'Dark' } },
      { kind: 'set-variable', target: 'otherNumber', value: 14, targetVariable: 'otherNumber', targetVariableModeId: 'Dark', targetVariableData: { id: 'otherNumber', modeId: 'Dark' } },
    ] }] } }
    const editor = new Editor(d)
    try {
      const api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument])
      const response = api.execute({ method: 'collection.renameMode', params: { collectionId: 'theme', mode: 'Dark', name: 'Night' }, documentId: d.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
      expect(response.ok, JSON.stringify(response)).toBe(true)
      const actions = editor.state.doc.prototype!.interactions[shape.id][0].actions
      expect(actions[0].targetVariableModeId).toBe('Night'); expect(actions[0].targetVariableData?.modeId).toBe('Night')
      expect(actions[1].targetVariableData?.modeId).toBe('Night')
      expect(actions[2].targetVariableModeId).toBe('Dark'); expect(actions[2].targetVariableData?.modeId).toBe('Dark')
      expect(editor.state.doc.designSystem!.variables.spacing.values.Night).toBe(16)
      editor.undo()
      expect(editor.state.doc.prototype!.interactions[shape.id][0].actions[0].targetVariableModeId).toBe('Dark')
    } finally { editor.dispose() }
  })
  it('blocks deleting modes, action variables, transition variables and condition variables still in use', () => {
    const { d, shape } = resources(); d.schemaVersion = 12
    d.prototype = { interactions: { [shape.id]: [{ trigger: 'click', condition: { variable: 'spacing', equals: 8 }, actions: [{ kind: 'back', targetVariableData: { id: 'brand', modeId: 'Dark' } }] }] } }
    expect(() => apply(d, 'collection.deleteMode', { collectionId: 'theme', mode: 'Dark' })).toThrow(/prototype action/)
    expect(() => apply(d, 'variable.delete', { variableId: 'spacing' })).toThrow(/prototype action or condition/)
    expect(() => apply(d, 'variable.delete', { variableId: 'brand' })).toThrow(/prototype action or condition/)
    delete d.prototype.interactions[shape.id][0].condition
    d.prototype.interactions[shape.id][0].actions = [{ kind: 'back', transitionDurationVar: 'spacing' }]
    expect(() => apply(d, 'variable.delete', { variableId: 'spacing' })).toThrow(/prototype action or condition/)
    d.prototype.interactions[shape.id][0].actions = [{ kind: 'back', transitionEasingVar: 'brand' }]
    expect(() => apply(d, 'variable.delete', { variableId: 'brand' })).toThrow(/prototype action or condition/)
    d.prototype.interactions[shape.id][0].actions = [{ kind: 'set-variable', target: 'spacing', value: 20 }]
    expect(() => apply(d, 'variable.delete', { variableId: 'spacing' })).toThrow(/prototype action or condition/)
  })
  it('creates collections, complete typed variables, and aliases', () => {
    let d = fixture().d
    d = apply(d, 'collection.create', { id: 'tokens', name: 'Tokens', modes: ['Base', 'Wide'], defaultMode: 'Base' }).document
    d = apply(d, 'variable.create', { id: 'gap', name: 'Gap', collectionId: 'tokens', kind: 'number', values: { Base: 4, Wide: 8 } }).document
    d = apply(d, 'variable.create', { id: 'alias', name: 'Alias', collectionId: 'tokens', kind: 'number', values: { Base: { alias: 'gap' }, Wide: { alias: 'gap' } } }).document
    expect(d.schemaVersion).toBeGreaterThanOrEqual(4)
    expect((apply(d, 'variable.resolve', { variableId: 'alias', modes: { tokens: 'Wide' } }).result as { value: number }).value).toBe(8)
    expect(() => apply(d, 'variable.create', { name: 'Incomplete', collectionId: 'tokens', kind: 'number', values: { Base: 1 } })).toThrow(/every collection mode/)
  })
  it('rejects missing aliases, incompatible alias types, and inactive-mode cycles', () => {
    const { d } = resources()
    expect(() => apply(d, 'variable.setValue', { variableId: 'brand', mode: 'Light', value: { alias: 'missing' } })).toThrow(/Unknown variable/)
    expect(() => apply(d, 'variable.setValue', { variableId: 'brand', mode: 'Light', value: { alias: 'spacing' } })).toThrow(/type mismatch/)
    expect(() => apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: { alias: 'spacing' } })).toThrow(/cycle/)
    const next = apply(d, 'variable.create', { id: 'alias', name: 'Alias', collectionId: 'theme', kind: 'number', values: { Light: 1, Dark: { alias: 'spacing' } } }).document
    expect(() => apply(next, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: { alias: 'alias' } })).toThrow(/cycle/)
    expect(() => apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: { alias: 'spacing', extra: 1 } })).toThrow(/only alias/)
  })
  it('accepts mutually exclusive mode aliases but rejects feasible cross-collection cycles', () => {
    const { d } = resources()
    d.designSystem!.variables.other = { name: 'Other', kind: 'number', collection: 'theme', values: { Light: 5, Dark: { alias: 'spacing' } } }
    const valid = apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Light', value: { alias: 'other' } }).document
    expect((apply(valid, 'variable.resolve', { variableId: 'spacing' }).result as { value: number }).value).toBe(5)
    const separate = apply(valid, 'collection.create', { id: 'second', name: 'Second', modes: ['Default'] }).document
    separate.designSystem!.variables.loop = { name: 'Loop', kind: 'number', collection: 'second', values: { Default: { alias: 'spacing' } } }
    expect(() => apply(separate, 'variable.setValue', { variableId: 'spacing', mode: 'Dark', value: { alias: 'loop' } })).toThrow(/cycle/)
  })
  it('validates all literal kinds and refuses unknown modes', () => {
    const { d } = resources()
    expect(() => apply(d, 'variable.setValue', { variableId: 'brand', mode: 'Light', value: 'javascript:alert(1)' })).toThrow(/Invalid color/)
    expect(() => apply(d, 'variable.setValue', { variableId: 'spacing', mode: 'Unknown', value: 1 })).toThrow(/Unknown variable mode/)
    expect(() => apply(d, 'variable.create', { name: 'Boolean', collectionId: 'theme', kind: 'boolean', values: { Light: true, Dark: 'false' } })).toThrow(/Invalid boolean/)
    expect(() => apply(d, 'variable.create', { name: 'String', collectionId: 'theme', kind: 'string', values: { Light: 'Yes', Dark: 1 } })).toThrow(/Invalid string/)
    expect(() => apply(d, 'variable.create', { name: 'Unknown', collectionId: 'theme', kind: 'gradient', values: { Light: 'x', Dark: 'y' } })).toThrow(/Unknown variable kind/)
  })
  it('copies, renames, and deletes modes with every node/override reference intact', () => {
    const { d, frame, text } = resources()
    Components.createMain(d, [frame.id], d.pages[0].id)
    const owner = Components.insertInstance(d, frame.id, d.pages[0].id, { x: 0, y: 0 })
    d.nodes[owner].variableModes = { theme: 'Dark' }
    d.nodes[owner].instance!.overrides[text.id] = { variableModes: { theme: 'Dark' } }
    const renamed = apply(d, 'collection.renameMode', { collectionId: 'theme', mode: 'Dark', name: 'Night' }).document
    expect(renamed.designSystem!.variables.brand.values.Night).toBe('#abcdef')
    expect(renamed.nodes[owner].variableModes?.theme).toBe('Night')
    expect(renamed.nodes[owner].instance!.overrides[text.id].variableModes).toEqual({ theme: 'Night' })
    expect(() => apply(renamed, 'collection.deleteMode', { collectionId: 'theme', mode: 'Night' })).toThrow(/referenced/)
    const added = apply(renamed, 'collection.addMode', { collectionId: 'theme', mode: 'High contrast', copyFrom: 'Night' }).document
    expect(added.designSystem!.variables.brand.values['High contrast']).toBe('#abcdef')
    const removed = apply(added, 'collection.deleteMode', { collectionId: 'theme', mode: 'High contrast' }).document
    expect(removed.designSystem!.collections.theme.modes).toEqual(['Light', 'Night'])
    expect(removed.designSystem!.variables.brand.values['High contrast']).toBeUndefined()
  })
  it('sets document and local modes, inheritance, and root replacing overrides', () => {
    const { d, frame, text } = resources()
    let next = apply(d, 'collection.setActiveMode', { collectionId: 'theme', mode: 'Dark' }).document
    next = apply(next, 'collection.setNodeMode', { nodeId: frame.id, collectionId: 'theme', mode: 'Light' }).document
    expect((apply(next, 'variable.resolve', { variableId: 'brand', nodeId: text.id }).result as { value: string }).value).toBe('#123456')
    next = apply(next, 'collection.setNodeMode', { nodeId: frame.id, collectionId: 'theme', mode: null }).document
    expect((apply(next, 'variable.resolve', { variableId: 'brand', nodeId: text.id }).result as { value: string }).value).toBe('#abcdef')
    Components.createMain(next, [frame.id], next.pages[0].id)
    const owner = Components.insertInstance(next, frame.id, next.pages[0].id, { x: 0, y: 0 })
    next.nodes[owner].instance!.overrides.$root = { variableModes: {} }
    next.nodes[frame.id].variableModes = { theme: 'Light' }
    expect((apply(next, 'variable.resolve', { variableId: 'brand', nodeId: owner }).result as { value: string }).value).toBe('#abcdef')
    next = apply(next, 'collection.setNodeMode', { nodeId: owner, collectionId: 'theme', mode: 'Light' }).document
    expect(next.nodes[owner].variableModes).toBeUndefined()
    expect(next.nodes[owner].instance!.overrides.$root.variableModes).toEqual({ theme: 'Light' })
    expect(() => apply(next, 'collection.setNodeMode', { nodeId: text.id, collectionId: 'missing', mode: null })).toThrow(/Unknown collection/)
  })
  it('binds only known typed fields and verifies fill slots', () => {
    const { d, text, shape } = resources()
    const bound = apply(d, 'variable.bind', { nodeId: shape.id, path: 'fills.0.color', variableId: 'brand' }).document
    expect(bound.nodes[shape.id].bindings).toEqual({ 'fills.0.color': 'brand' })
    expect(() => apply(d, 'variable.bind', { nodeId: shape.id, path: 'opacity', variableId: 'brand' })).toThrow(/type mismatch/)
    expect(() => apply(d, 'variable.bind', { nodeId: shape.id, path: 'fills.1.color', variableId: 'brand' })).toThrow(/index/)
    expect(() => apply(d, 'variable.bind', { nodeId: shape.id, path: '__proto__.x', variableId: 'spacing' })).toThrow(/Unsupported/)
    expect(() => apply(d, 'variable.bind', { nodeId: shape.id, path: 'layout.gap', variableId: 'spacing' })).toThrow(/layout/)
    const unbound = apply(bound, 'variable.unbind', { nodeId: shape.id, path: 'fills.0.color' }).document
    expect(unbound.nodes[shape.id].bindings).toEqual({})
    expect(apply(d, 'variable.bind', { nodeId: text.id, path: 'textStyle.letterSpacing', variableId: 'spacing' }).document.nodes[text.id].bindings).toEqual({ 'textStyle.letterSpacing': 'spacing' })
  })
  it('prevents dangling collection, variable, and alias references on deletion', () => {
    const { d, shape } = resources()
    expect(() => apply(d, 'collection.delete', { collectionId: 'theme' })).toThrow(/referenced/)
    const bound = apply(d, 'variable.bind', { nodeId: shape.id, path: 'fills.0.color', variableId: 'brand' }).document
    expect(() => apply(bound, 'variable.delete', { variableId: 'brand' })).toThrow(/referenced/)
    const aliased = apply(d, 'variable.create', { id: 'alias', name: 'Alias', collectionId: 'theme', kind: 'color', values: { Light: { alias: 'brand' }, Dark: '#ffffff' } }).document
    expect(() => apply(aliased, 'variable.delete', { variableId: 'brand' })).toThrow(/referenced/)
    const removed = apply(d, 'variable.delete', { variableId: 'brand' }).document
    expect(removed.designSystem!.variables.brand).toBeUndefined()
  })
})

describe('document font metadata', () => {
  it('imports only caller-provided, parsed, licensed-for-embedding faces within inline budgets', () => {
    const { d } = fixture()
    const imported = apply(d, 'font.import', { id: 'test-font', data: testFont, embeddingAllowed: true })
    expect(imported.document.fonts?.['test-font']).toMatchObject({ family: 'Automation Test Regular', postscript: 'AutomationTest-Regular', index: 0, data: testFont })
    expect((apply(imported.document, 'font.validate').result as { valid: boolean }).valid).toBe(true)
    expect(JSON.stringify(imported.result)).not.toContain(testFont)
    expect(() => apply(d, 'font.import', { data: testFont, embeddingAllowed: false })).toThrow(/permission/)
    expect(() => apply(d, 'font.import', { data: 'AAAA', embeddingAllowed: true })).toThrow()
    expect(() => apply(d, 'font.import', { data: testFont, faceIndex: 1, embeddingAllowed: true })).toThrow(/index/)
    expect(() => apply(d, 'font.import', { data: 'A'.repeat(27_962_032), embeddingAllowed: true })).toThrow(/20 MiB/)
    expect(() => apply(d, 'font.import', { id: 'default', data: testFont, embeddingAllowed: true })).toThrow(/Invalid font/)
    expect(() => apply(imported.document, 'font.import', { id: 'test-font', data: testFont, embeddingAllowed: true })).toThrow(/exists/)
  })
  it('rejects restricted embedding flags even when the caller asserts permission', () => {
    const bytes = Buffer.from(testFont, 'base64')
    const count = bytes.readUInt16BE(4)
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16
      if (bytes.toString('ascii', at, at + 4) === 'OS/2') bytes.writeUInt16BE(2, bytes.readUInt32BE(at + 8) + 8)
    }
    expect(() => apply(fixture().d, 'font.import', { data: bytes.toString('base64'), embeddingAllowed: true })).toThrow(/embedding flags/)
  })
  it('commits Arabic, CJK and mixed-run typography through the real atomic API', () => {
    const { d, text } = fixture(), editor = new Editor(d)
    try {
      const api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument])
      const run = (method: string, params: Record<string, unknown>) => {
        const result = api.execute({ method, params, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
        expect(result.ok, JSON.stringify(result)).toBe(true)
        return result
      }
      run('font.import', { id: 'custom', data: testFont, embeddingAllowed: true })
      run('text.set', { ids: [text.id], text: 'Aا中', textStyle: { fontId: 'custom', direction: 'rtl', weight: 500, letterSpacing: 0.25 }, textRuns: [{ start: 0, end: 1, fontId: 'default', weight: 700 }, { start: 1, end: 3, fontId: 'custom', weight: 400 }] })
      run('font.apply', { nodeIds: [text.id], fontId: 'custom', weight: 600, direction: 'auto', letterSpacing: 1.5, lineHeight: 1.8 })
      const n = editor.state.doc.nodes[text.id]
      expect(n.text).toBe('Aا中')
      expect(n.textStyle).toMatchObject({ fontId: 'custom', direction: 'auto', weight: 600, letterSpacing: 1.5, lineHeight: 1.8 })
      expect(n.textRuns).toEqual([{ start: 0, end: 1, fontId: 'default', weight: 700 }, { start: 1, end: 3, fontId: 'custom', weight: 400 }])
      const before = editor.state.doc
      const bad = api.execute({ method: 'font.apply', params: { nodeIds: [text.id], fontId: 'missing' }, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
      expect(bad.ok).toBe(false); expect(editor.state.doc).toBe(before)
      run('font.apply', { nodeIds: [text.id], fontId: 'custom', weight: 500, preserveRuns: false })
      expect(editor.state.doc.nodes[text.id].textRuns?.every(r => r.fontId === undefined && r.weight === undefined)).toBe(true)
    } finally { editor.dispose() }
  })
  it('imports the bundled 17.8 MiB OFL CJK font through the actual large-request API', () => {
    const { d, text } = fixture(), editor = new Editor(d)
    try {
      const api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument])
      const data = readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)).toString('base64')
      expect(data.length).toBeGreaterThan(8 * 1024 * 1024)
      const call = (method: string, params: Record<string, unknown>) => api.execute({ method, params, documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
      const imported = call('font.import', { id: 'cjk', data, embeddingAllowed: true })
      expect(imported.ok, JSON.stringify(imported)).toBe(true)
      expect(editor.state.doc.fonts!.cjk.family).toContain('Noto Sans SC')
      expect(editor.state.doc.fonts!.cjk.data).toBe(data)
      const applied = call('text.set', { ids: [text.id], text: '字体测试117', textStyle: { fontId: 'cjk', weight: 700, letterSpacing: 0.5 } })
      expect(applied.ok, JSON.stringify(applied)).toBe(true)
      expect(editor.state.doc.nodes[text.id].text).toBe('字体测试117')
      const before = editor.state.doc, duplicate = call('font.import', { id: 'over-budget', data, embeddingAllowed: true })
      expect(duplicate.ok).toBe(false)
      if (!duplicate.ok) expect(duplicate.error.message).toContain('24 MiB')
      expect(editor.state.doc).toBe(before)
    } finally { editor.dispose() }
  }, 20_000)
  it('lists embedded resources and requested weights without returning font bytes', () => {
    const { d, text } = fixture()
    d.fonts = { custom: { family: 'Custom Sans', postscript: 'CustomSans-Regular', index: 0, data: 'PRIVATE_FONT_BYTES' } }
    text.textStyle = { ...defaultTextStyle(), fontId: 'custom', weight: 400 }
    text.textRuns = [{ start: 0, end: 1, fontId: 'custom', weight: 700 }]
    const result = apply(d, 'font.list').result as { fonts: Array<{ id: string; family: string; usedWeights: number[]; nodeIds: string[] }> }
    expect(result.fonts.find(f => f.id === 'custom')).toMatchObject({ family: 'Custom Sans', usedWeights: [400, 700], nodeIds: [text.id] })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FONT_BYTES')
    expect(JSON.stringify(result)).not.toContain('"data"')
  })
  it('reports absent font references and unresolved imported font identities', () => {
    const { d, text, shape } = resources()
    text.textStyle = { ...defaultTextStyle(), fontId: 'missing-font' }
    shape.kind = 'text'; shape.textStyle = defaultTextStyle()
    d.designSystem!.fontSources = { [shape.id]: { style: 'OriginalSans-Regular' } }
    const result = apply(d, 'font.list').result as { missingReferences: Array<{ id: string }>; unresolvedSources: Array<{ nodeId: string; sourceNames: string[] }> }
    expect(result.missingReferences).toEqual([expect.objectContaining({ id: 'missing-font', source: 'missing' })])
    expect(result.unresolvedSources).toEqual([{ nodeId: shape.id, sourceNames: ['OriginalSans-Regular'], fallbackFontId: 'default' }])
  })
})

describe('shared styles', () => {
  it('creates, reads, updates, applies, and unapplies all local style kinds', () => {
    const { d, shape, text } = resources()
    let next = apply(d, 'style.create', { id: 'body', name: 'Body', kind: 'text', value: defaultTextStyle() }).document
    next = apply(next, 'style.create', { id: 'shadow', name: 'Shadow', kind: 'effect', value: [effect('shadow')] }).document
    next = apply(next, 'style.apply', { nodeId: text.id, field: 'textStyle', styleId: 'body' }).document
    next = apply(next, 'style.apply', { nodeId: shape.id, field: 'effects', styleId: 'shadow' }).document
    next = apply(next, 'style.apply', { nodeId: shape.id, field: 'fills', styleId: 'fill' }).document
    expect(next.nodes[shape.id].styleRefs).toEqual({ effects: 'shadow', fills: 'fill' })
    expect(() => apply(next, 'style.delete', { styleId: 'fill' })).toThrow(/referenced/)
    next = apply(next, 'style.update', { styleId: 'fill', name: 'Updated', value: [paint('#ffffff')] }).document
    expect((apply(next, 'style.get', { styleId: 'fill' }).result as { name: string }).name).toBe('Updated')
    next = apply(next, 'style.unapply', { nodeId: shape.id, field: 'fills' }).document
    next = apply(next, 'style.delete', { styleId: 'fill' }).document
    expect(next.designSystem!.styles.fill).toBeUndefined()
  })
  it('rejects malformed style values, unsupported fields, and mismatched target kinds', () => {
    const { d, shape } = resources()
    expect(() => apply(d, 'style.create', { name: 'Bad', kind: 'paint', value: [{ kind: 'solid', color: 'invalid' }] })).toThrow()
    expect(() => apply(d, 'style.create', { name: 'Bad', kind: 'effect', value: [{ ...effect('shadow'), radius: -1 }] })).toThrow()
    expect(() => apply(d, 'style.apply', { nodeId: shape.id, field: 'effects', styleId: 'fill' })).toThrow(/mismatch/)
    expect(() => apply(d, 'style.apply', { nodeId: shape.id, field: 'strokes', styleId: 'fill' })).toThrow(/Unsupported/)
    const textStyle = apply(d, 'style.create', { id: 'text', name: 'Text', kind: 'text', value: defaultTextStyle() }).document
    expect(() => apply(textStyle, 'style.apply', { nodeId: shape.id, field: 'textStyle', styleId: 'text' })).toThrow(/mismatch/)
    expect(() => apply(d, 'style.create', { name: 'Bad', kind: 'text', value: defaultTextStyle(), strokes: [stroke()] })).toThrow(/Only paint/)
  })
  it('admits paint style stroke/effect payloads with the correct schema gate', () => {
    const { d } = resources()
    const next = apply(d, 'style.create', { id: 'complete', name: 'Complete layer', kind: 'paint', value: [paint()], strokes: [stroke()], effects: [effect('shadow')] }).document
    expect(next.schemaVersion).toBeGreaterThanOrEqual(12)
    expect(next.designSystem!.styles.complete.strokes).toHaveLength(1)
  })
  it('rejects style deletion when only an instance override still references it', () => {
    const { d, frame, text } = resources()
    Components.createMain(d, [frame.id], d.pages[0].id)
    const id = Components.insertInstance(d, frame.id, d.pages[0].id, { x: 0, y: 0 })
    d.nodes[id].instance!.overrides[text.id] = { styleRefs: { fills: 'fill' } }
    expect(() => apply(d, 'style.delete', { styleId: 'fill' })).toThrow(/referenced/)
  })
  it('extra admission detects dangling resources in a structurally valid document', () => {
    const { d, shape } = resources()
    d.nodes[shape.id].bindings = { opacity: 'missing' }
    expect(() => validateDesignSystemDocument(d)).toThrow(/Unknown variable/)
    delete d.nodes[shape.id].bindings
    d.nodes[shape.id].styleRefs = { effects: 'fill' }
    expect(() => validateDesignSystemDocument(d)).toThrow(/mismatch/)
  })
})

describe('mixed prototype target mode integrity', () => {
  it.each(['theme', 'other'])('keeps playback and history correct through actual API rename of %s', collectionId => {
    const { d, shape } = resources(); d.schemaVersion = 12
    d.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
    d.designSystem!.variables.otherNumber = { name: 'Other', kind: 'number', collection: 'other', values: { Light: 1, Dark: 2 } }
    d.prototype = { startNode: shape.id, interactions: { [shape.id]: [{ trigger: 'click', actions: [{
      kind: 'set-variable', target: 'spacing', targetVariable: 'spacing', targetVariableData: { id: 'otherNumber', modeId: 'Dark' }, value: 99,
    }] }] } }
    const editor = new Editor(d)
    try {
      const api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument]), before = editor.state.doc
      const execute = (method: string, params: Record<string, unknown>) => api.execute({ method, params, documentId: d.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
      const playback = () => prototypeEvent(editor.state.doc, initialPrototype(editor.state.doc), shape.id, 'click')
      expect(playback().modeValues?.spacing.Dark).toBe(99)
      const blocked = execute('collection.deleteMode', { collectionId: 'theme', mode: 'Dark' })
      expect(blocked.ok).toBe(false); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
      if (!blocked.ok) expect(blocked.error.message).toContain('prototype action')
      const renamed = execute('collection.renameMode', { collectionId, mode: 'Dark', name: 'Night' })
      expect(renamed.ok, JSON.stringify(renamed)).toBe(true)
      const mode = collectionId === 'theme' ? 'Night' : 'Dark'
      expect(playback().modeValues?.spacing[mode]).toBe(99)
      expect(editor.state.doc.prototype!.interactions[shape.id][0].actions[0].targetVariableData?.modeId).toBe(collectionId === 'other' ? 'Night' : 'Dark')
      editor.undo(); expect(editor.state.doc).toEqual(before); expect(playback().modeValues?.spacing.Dark).toBe(99)
      editor.redo(); expect(playback().modeValues?.spacing[mode]).toBe(99)
    } finally { editor.dispose() }
  })
})

describe('compound mode migration inheritance', () => {
  it.each(['two-collections', 'two-modes', 'rename-and-value', 'existing-name-swap'] as const)('handles actual API %s batch without silently freezing inherited children', combination => {
    const { d, frame, shape } = resources()
    d.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
    d.designSystem!.variables.otherNumber = { name: 'Other', kind: 'number', collection: 'other', values: { Light: 1, Dark: 2 } }
    frame.component = { properties: {}, variants: {} }; shape.variableModes = { theme: 'Dark', other: 'Dark' }
    shape.bindings = { width: 'spacing', height: 'otherNumber' }; Components.stampKeys(d, frame.id)
    const instance = Components.insertInstance(d, frame.id, d.pages[0].id, { x: 300, y: 0 }), editor = new Editor(d)
    try {
      const api = createDesignAutomation(editor, designSystemExtensions, [validateDesignSystemDocument]), before = editor.state.doc, revision = editor.state.version
      const operation = (method: string, params: Record<string, unknown>) => ({ method, params })
      const operations = combination === 'existing-name-swap' ? [
        operation('collection.renameMode', { collectionId: 'theme', mode: 'Dark', name: 'Temp' }),
        operation('collection.renameMode', { collectionId: 'theme', mode: 'Light', name: 'Dark' }),
        operation('collection.renameMode', { collectionId: 'theme', mode: 'Temp', name: 'Light' }),
      ] : [operation('collection.renameMode', { collectionId: 'theme', mode: 'Dark', name: 'Night' }),
        combination === 'two-collections' ? operation('collection.renameMode', { collectionId: 'other', mode: 'Dark', name: 'Night' }) :
        combination === 'two-modes' ? operation('collection.renameMode', { collectionId: 'theme', mode: 'Light', name: 'Day' }) :
        operation('variable.setValue', { variableId: 'spacing', mode: 'Night', value: 30 })]
      const response = api.execute({ method: 'batch.apply', params: { operations }, documentId: d.id, session: editor.sessionGeneration, expectedRevision: revision })
      if (combination === 'rename-and-value' || combination === 'existing-name-swap') {
        expect(response.ok).toBe(false); expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(revision); expect(editor.canUndo).toBe(false)
        if (!response.ok) expect(response.error.message).toContain('请分开操作')
        if (combination === 'rename-and-value') {
          const rename = api.execute({ ...operations[0], documentId: d.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
          expect(rename.ok, JSON.stringify(rename)).toBe(true)
          const value = api.execute({ ...operations[1], documentId: d.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
          expect(value.ok, JSON.stringify(value)).toBe(true)
          expect(editor.state.doc.designSystem!.variables.spacing.values.Night).toBe(30)
          expect(editor.state.doc.nodes[instance].instance!.overrides).toEqual({})
        }
        return
      }
      expect(response.ok, JSON.stringify(response)).toBe(true); expect(editor.state.version).toBe(revision + 1)
      expect(editor.state.doc.nodes[instance].instance!.overrides).toEqual({})
      expect(editor.state.doc.designSystem!.collections.theme.modes).toContain('Night')
      const migrated = editor.state.doc
      editor.undo(); expect(editor.state.doc).toEqual(before); editor.redo(); expect(editor.state.doc).toEqual(migrated)
      editor.change('Later source mode edit', doc => { doc.nodes[shape.id].variableModes = { theme: combination === 'two-modes' ? 'Day' : 'Light', other: 'Light' } })
      const generated = Object.values(editor.state.doc.nodes).find(n => n.instanceOrigin?.owner === instance && n.instanceOrigin.key === shape.componentKey)!
      expect(generated.width).toBe(8); expect(generated.height).toBe(1)
      expect(editor.state.doc.nodes[instance].instance!.overrides).toEqual({})
    } finally { editor.dispose() }
  })
})
