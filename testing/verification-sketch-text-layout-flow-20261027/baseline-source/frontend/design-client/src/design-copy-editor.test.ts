import { test, expect } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, validateDocument } from './model'
import { emptySystem, variableValue } from './design-system'
import { componentFixture, originNode } from './component-fixtures'
import { insertInstance, stampKeys } from './components'

function boundLayer() {
  const source = blank('Source'),
    layer = node('rectangle')
  source.schemaVersion = 4
  source.nodes[layer.id] = layer
  source.pages[0].children = [layer.id]
  const system = (source.designSystem = emptySystem())
  system.collections.theme = { name: 'Theme', modes: ['light', 'dark'], defaultMode: 'light' }
  system.activeModes.theme = 'dark'
  system.variables.brand = {
    name: 'Brand',
    kind: 'color',
    collection: 'theme',
    values: { light: '#ff0000', dark: '#0000ff' },
  }
  system.variables.alias = {
    name: 'Alias',
    kind: 'color',
    collection: 'theme',
    values: { light: { alias: 'brand' }, dark: { alias: 'brand' } },
  }
  system.styles.fill = { name: 'Fill', kind: 'paint', value: [paint('#112233')] }
  layer.bindings = { 'fills.0.color': 'alias' }
  layer.styleRefs = { fills: 'fill' }
  return { source, layer }
}

test('cross-document layer paste preserves live bindings and shared styles through undo/redo', () => {
  const { source, layer } = boundLayer(),
    editor = new Editor(source)
  const sourceDocument = editor.state.doc,
    sourceBefore = structuredClone(sourceDocument)
  editor.select([layer.id])
  editor.copy()
  editor.load(blank('Target'))
  const before = structuredClone(editor.state.doc)
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted, editor.state.message).toBeTruthy()
  expect(pasted.fills[0].color).toBe('#0000ff')
  expect(pasted.bindings?.['fills.0.color']).toBeTruthy()
  expect(editor.state.doc.designSystem!.styles[pasted.styleRefs!.fills].kind).toBe('paint')
  expect(sourceDocument).toEqual(sourceBefore)
  const after = structuredClone(editor.state.doc)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.redo()
  expect(editor.state.doc.designSystem).toEqual(after.designSystem)
  expect(editor.state.doc.nodes[pasted.id]).toMatchObject({
    bindings: pasted.bindings,
    styleRefs: pasted.styleRefs,
    fills: [{ color: '#0000ff' }],
  })
  editor.change('Change imported theme', (d) => {
    const variable = d.designSystem!.variables[pasted.bindings!['fills.0.color']]
    d.designSystem!.activeModes[variable.collection] = 'light'
  })
  expect(editor.state.doc.nodes[pasted.id].fills[0].color).toBe('#ff0000')
  expect(sourceDocument).toEqual(sourceBefore)
})

test('colliding layer resources do not change destination nodes or modes, including repeated paste', () => {
  const { source, layer } = boundLayer(),
    target = structuredClone(source)
  target.id = blank().id
  target.designSystem!.activeModes.theme = 'light'
  target.designSystem!.variables.brand.values.light = '#00ff00'
  const editor = new Editor(source)
  editor.select([layer.id])
  editor.copy()
  editor.load(target)
  const before = structuredClone(editor.state.doc)
  editor.paste()
  const first = editor.state.doc.nodes[editor.state.selection[0]]
  expect(first, editor.state.message).toBeTruthy()
  expect(first.fills[0].color).toBe('#0000ff')
  expect(first.bindings!['fills.0.color']).not.toBe('alias')
  expect(first.styleRefs!.fills).not.toBe('fill')
  expect(editor.state.doc.nodes[layer.id]).toEqual(before.nodes[layer.id])
  expect(editor.state.doc.designSystem!.activeModes.theme).toBe('light')
  editor.paste()
  const second = editor.state.doc.nodes[editor.state.selection[0]]
  expect(second.fills[0].color).toBe('#0000ff')
  expect(second.id).not.toBe(first.id)
  expect(editor.state.doc.nodes[first.id]).toEqual(first)
  expect(() => validateDocument(editor.state.doc)).not.toThrow()
  editor.undo()
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('pasting a main component imports bound definitions despite matching destination node IDs', () => {
  const { source, layer } = boundLayer()
  layer.kind = 'frame'
  layer.component = { variants: {}, properties: {} }
  layer.componentKey = '$root'
  const target = structuredClone(source)
  target.id = blank().id
  target.designSystem!.variables.brand.values.dark = '#00ff00'
  const editor = new Editor(source),
    sourceDocument = editor.state.doc,
    sourceBefore = structuredClone(sourceDocument)
  editor.select([layer.id])
  editor.copy()
  editor.load(target)
  const before = structuredClone(editor.state.doc)
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted?.instance, editor.state.message).toBeTruthy()
  expect(pasted.instance!.componentId).not.toBe(layer.id)
  expect(pasted.fills[0].color).toBe('#0000ff')
  expect(editor.state.doc.nodes[layer.id]).toEqual(before.nodes[layer.id])
  expect(sourceDocument).toEqual(sourceBefore)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('pasted instances retain nested swapped component bindings and shared styles', () => {
  const { doc, ids } = componentFixture(),
    { source } = boundLayer()
  doc.schemaVersion = 4
  doc.designSystem = source.designSystem
  doc.nodes[ids.label].bindings = { 'fills.0.color': 'alias' }
  doc.nodes[ids.iconB].styleRefs = { fills: 'fill' }
  const editor = new Editor(doc)
  editor.setComponentProperty(ids.a, ids.icon, ids.iconB)
  const sourceDocument = editor.state.doc,
    sourceBefore = structuredClone(sourceDocument)
  editor.select([ids.a])
  editor.copy()
  editor.load(blank('Target'))
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted?.instance, editor.state.message).toBeTruthy()
  const label = originNode(editor.state.doc, pasted.id, doc.nodes[ids.label].componentKey!)
  expect(label.fills[0].color).toBe('#0000ff')
  const slot = originNode(editor.state.doc, pasted.id, doc.nodes[ids.slot].componentKey!)
  expect(slot.instance!.componentId).toBe(ids.iconB)
  expect(slot.fills[0].color).toBe('#112233')
  expect(variableValue(editor.state.doc.designSystem!, label.bindings!['fills.0.color'])).toBe(
    '#0000ff',
  )
  expect(() => validateDocument(editor.state.doc)).not.toThrow()
  expect(sourceDocument).toEqual(sourceBefore)
})

test('missing clipboard dependencies reject paste atomically', () => {
  const { source, layer } = boundLayer(),
    editor = new Editor(source)
  editor.select([layer.id])
  editor.copy()
  // Exercise corrupt/outdated clipboard input without changing the destination.
  delete editor.state.doc.designSystem!.variables.brand
  editor.load(blank('Target'))
  const before = editor.state.doc
  editor.paste()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toMatch(/变量|集合/)
})

test('instance binding and style edits stay live while explicit values keep precedence', () => {
  const { source, layer } = boundLayer(),
    child = node('rectangle', 0, 0, 20, 20)
  layer.kind = 'frame'
  layer.component = { variants: {}, properties: {} }
  layer.children = [child.id]
  source.nodes[child.id] = child
  const system = source.designSystem!
  system.variables.small = {
    name: 'Small',
    kind: 'number',
    collection: 'theme',
    values: { light: 20, dark: 20 },
  }
  system.variables.large = {
    name: 'Large',
    kind: 'number',
    collection: 'theme',
    values: { light: 80, dark: 80 },
  }
  system.styles.alternate = { name: 'Alternate', kind: 'paint', value: [paint('#abcdef')] }
  child.bindings = { width: 'small' }
  child.styleRefs = { fills: 'fill' }
  stampKeys(source, layer.id)
  const instance = insertInstance(source, layer.id, source.pages[0].id, { x: 300, y: 300 })
  const editor = new Editor(source)
  const generated = originNode(editor.state.doc, instance, child.componentKey!)
  editor.update([generated.id], { bindings: { width: 'large' } })
  expect(editor.state.doc.nodes[generated.id].width, editor.state.message).toBe(80)
  editor.update([generated.id], { styleRefs: { fills: 'alternate' } })
  expect(editor.state.doc.nodes[generated.id].fills[0].color, editor.state.message).toBe('#abcdef')
  editor.update([generated.id], { width: 37 })
  expect(editor.state.doc.nodes[generated.id].width).toBe(37)
  editor.change('Change variable', (d) => {
    d.designSystem!.variables.large.values.dark = 99
  })
  expect(editor.state.doc.nodes[generated.id].width).toBe(37)
  const sourceDocument = editor.state.doc,
    before = structuredClone(sourceDocument)
  editor.select([instance])
  editor.copy()
  editor.load(blank('Target'))
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted?.instance, editor.state.message).toBeTruthy()
  const copiedChild = originNode(editor.state.doc, pasted.id, child.componentKey!)
  expect(copiedChild.width).toBe(37)
  expect(copiedChild.fills[0].color).toBe('#abcdef')
  expect(sourceDocument).toEqual(before)
  editor.resetInstance(copiedChild.id)
  expect(editor.state.doc.nodes[copiedChild.id].width).toBe(20)
  expect(editor.state.doc.nodes[copiedChild.id].fills[0].color).toBe('#112233')
})

test('copying a generated nested instance remaps lifted deep property swaps on ID collision', () => {
  const source = blank('Nested source')
  source.schemaVersion = 4
  const main = () => {
    const n = node('frame')
    n.component = { variants: {}, properties: {} }
    source.nodes[n.id] = n
    source.pages[0].children.push(n.id)
    return n
  }
  const iconA = main(),
    iconB = main(),
    leaf = main(),
    middle = main(),
    outer = main(),
    top = main()
  iconA.name = 'Original icon'
  iconB.name = 'Alternate icon'
  const iconSlot = insertInstance(source, iconA.id, source.pages[0].id, { x: 0, y: 0 }, leaf.id)
  stampKeys(source, leaf.id)
  leaf.component!.properties.swap = {
    name: 'Icon',
    kind: 'instance-swap',
    targetKey: source.nodes[iconSlot].componentKey!,
    defaultValue: iconA.id,
  }
  const leafSlot = insertInstance(source, leaf.id, source.pages[0].id, { x: 0, y: 0 }, middle.id)
  stampKeys(source, middle.id)
  const middleSlot = insertInstance(source, middle.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  stampKeys(source, outer.id)
  const outerSlot = insertInstance(source, outer.id, source.pages[0].id, { x: 0, y: 0 }, top.id)
  stampKeys(source, top.id)
  const owner = insertInstance(source, top.id, source.pages[0].id, { x: 300, y: 300 })
  const relative = `${source.nodes[middleSlot].componentKey}/${source.nodes[leafSlot].componentKey}`
  const prefix = source.nodes[outerSlot].componentKey!
  source.nodes[owner].instance!.overrides[`${prefix}/${relative}`] = {
    propertyValues: { swap: iconB.id },
  }
  const editor = new Editor(source),
    original = editor.state.doc
  const copiedRoot = originNode(original, owner, prefix)
  editor.select([copiedRoot.id])
  editor.copy()
  const target = blank('Collision target')
  target.schemaVersion = 4
  target.nodes[iconB.id] = { ...structuredClone(iconA), id: iconB.id, name: 'Destination icon' }
  target.pages[0].children = [iconB.id]
  editor.load(target)
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted?.instance, editor.state.message).toBeTruthy()
  const values = pasted.instance!.overrides[relative].propertyValues as Record<string, string>
  expect(values.swap).not.toBe(iconB.id)
  expect(editor.state.doc.nodes[values.swap].name).toBe('Alternate icon')
  expect(editor.state.doc.nodes[iconB.id].name).toBe('Destination icon')
  expect(() => validateDocument(editor.state.doc)).not.toThrow()
})

test('mixed selection keeps pasted instances linked to the pasted main component', () => {
  const { doc, ids } = componentFixture(),
    { source } = boundLayer()
  doc.schemaVersion = 4
  doc.designSystem = source.designSystem
  doc.nodes[ids.label].bindings = { 'fills.0.color': 'alias' }
  const editor = new Editor(doc)
  editor.select([ids.button, ids.a])
  editor.copy()
  editor.load(blank('Mixed target'))
  editor.paste()
  expect(editor.state.selection.length, editor.state.message).toBe(2)
  const [main, instance] = editor.state.selection.map((id) => editor.state.doc.nodes[id])
  expect(main.component).toBeTruthy()
  expect(instance.instance!.componentId).toBe(main.id)
  expect(
    originNode(editor.state.doc, instance.id, doc.nodes[ids.label].componentKey!).fills[0].color,
  ).toBe('#0000ff')
  expect(() => validateDocument(editor.state.doc)).not.toThrow()
})
