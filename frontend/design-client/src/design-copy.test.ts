import assert from 'node:assert/strict'
import { test } from 'vitest'
import { blank, defaultTextStyle, node, paint } from './model'
import {
  captureOverrides,
  importClipboardDependencies,
  importDefinitions,
  insertInstance,
  remapReferences,
  stampKeys,
} from './components'
import { emptySystem, remapDesignDependencies, variableValue } from './design-system'

function fixture() {
  const source = blank('Source'),
    root = node('frame'),
    child = node('rectangle')
  source.schemaVersion = 4
  root.component = { variants: {}, properties: {} }
  root.children = [child.id]
  source.nodes = { [root.id]: root, [child.id]: child }
  source.pages[0].children = [root.id]
  stampKeys(source, root.id)
  const system = (source.designSystem = emptySystem())
  system.collections.theme = { name: 'Theme', modes: ['day', 'night'], defaultMode: 'day' }
  system.collections.tokens = { name: 'Tokens', modes: ['base', 'alternate'], defaultMode: 'base' }
  system.activeModes = { theme: 'night', tokens: 'alternate' }
  system.variables.brand = {
    name: 'Brand',
    kind: 'color',
    collection: 'tokens',
    values: { base: '#ff0000', alternate: '#0000ff' },
  }
  system.variables.dayOnly = {
    name: 'Day only',
    kind: 'color',
    collection: 'tokens',
    values: { base: '#00ff00', alternate: '#ffff00' },
  }
  system.variables.alias = {
    name: 'Alias',
    kind: 'color',
    collection: 'theme',
    values: { day: { alias: 'dayOnly' }, night: { alias: 'brand' } },
  }
  system.variables.unused = {
    name: 'Unused',
    kind: 'number',
    collection: 'theme',
    values: { day: 1, night: 2 },
  }
  system.styles.fill = { name: 'Fill', kind: 'paint', value: [paint('#112233')] }
  system.styles.unused = { name: 'Unused style', kind: 'paint', value: [] }
  child.bindings = { 'fills.0.color': 'alias' }
  child.styleRefs = { fills: 'fill' }
  return { source, root, child }
}

test('component import copies only reachable styles, aliases in every mode, and active collections', () => {
  const { source, root, child } = fixture(),
    target = blank('Target')
  const before = structuredClone(source)
  importDefinitions(target, source, root.id)
  assert.ok(target.designSystem, 'The copied bindings need their source design system')
  const copied = target.nodes[child.id],
    system = target.designSystem
  assert.equal(variableValue(system, copied.bindings!['fills.0.color']), '#0000ff')
  assert.deepEqual(system.styles[copied.styleRefs!.fills], source.designSystem!.styles.fill)
  assert.deepEqual(new Set(Object.keys(system.variables)), new Set(['alias', 'brand', 'dayOnly']))
  assert.equal(system.variables.unused, undefined)
  assert.equal(system.styles.unused, undefined)
  system.activeModes.theme = 'day'
  assert.equal(variableValue(system, copied.bindings!['fills.0.color']), '#ffff00')
  assert.deepEqual(source, before)
  system.variables.brand.values.alternate = '#ffffff'
  assert.deepEqual(source, before, 'Imported resources must not share mutable source objects')
})

test('component and design-system ID collisions preserve the destination and isolate imported references', () => {
  const { source, root, child } = fixture(),
    target = structuredClone(source)
  target.id = blank().id
  target.nodes[root.id].name = 'Destination component'
  target.designSystem!.variables.brand.values.alternate = '#123456'
  target.designSystem!.activeModes.theme = 'day'
  const before = structuredClone(target)
  const imported = importDefinitions(target, source, root.id) || root.id
  assert.notEqual(imported, root.id, 'A colliding destination component cannot replace the source')
  assert.deepEqual(target.nodes[root.id], before.nodes[root.id])
  assert.deepEqual(target.nodes[child.id], before.nodes[child.id])
  for (const [id, value] of Object.entries(before.designSystem!.variables))
    assert.deepEqual(target.designSystem!.variables[id], value)
  const copied = target.nodes[target.nodes[imported].children[0]]
  assert.notEqual(copied.id, child.id)
  assert.notEqual(copied.bindings!['fills.0.color'], 'alias')
  assert.notEqual(copied.styleRefs!.fills, 'fill')
  assert.equal(variableValue(target.designSystem!, copied.bindings!['fills.0.color']), '#0000ff')
  assert.equal(target.designSystem!.activeModes.theme, 'day')
})

test('nested components, swap defaults and their bound styles follow one remapped dependency closure', () => {
  const { source, root, child } = fixture()
  const outer = node('frame'),
    alternate = node('frame')
  outer.component = { variants: {}, properties: {} }
  alternate.component = { variants: {}, properties: {} }
  alternate.bindings = { opacity: 'opacity' }
  source.designSystem!.variables.opacity = {
    name: 'Opacity',
    kind: 'number',
    collection: 'theme',
    values: { day: 0.3, night: 0.6 },
  }
  source.nodes[outer.id] = outer
  source.nodes[alternate.id] = alternate
  source.pages[0].children.push(outer.id, alternate.id)
  const nested = insertInstance(source, root.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  stampKeys(source, outer.id)
  outer.component.properties.swap = {
    name: 'Swap',
    kind: 'instance-swap',
    targetKey: source.nodes[nested].componentKey!,
    defaultValue: alternate.id,
  }
  const target = structuredClone(source)
  target.id = blank().id
  const before = structuredClone(source)
  const imported = importDefinitions(target, source, outer.id) || outer.id
  const copied = target.nodes[imported],
    copiedNested = target.nodes[copied.children[0]]
  assert.notEqual(copiedNested.instance!.componentId, root.id)
  const copiedRoot = target.nodes[copiedNested.instance!.componentId]
  const copiedChild = target.nodes[copiedRoot.children[0]]
  assert.notEqual(copiedChild.id, child.id)
  assert.equal(
    variableValue(target.designSystem!, copiedChild.bindings!['fills.0.color']),
    '#0000ff',
  )
  const swap = String(copied.component!.properties.swap.defaultValue)
  assert.notEqual(swap, alternate.id)
  assert.equal(variableValue(target.designSystem!, target.nodes[swap].bindings!.opacity), 0.6)
  assert.deepEqual(source, before)
})

test('same-document copies keep live component and design-system identities', () => {
  const { source, root } = fixture(),
    before = structuredClone(source)
  assert.equal(importDefinitions(source, structuredClone(source), root.id) || root.id, root.id)
  assert.deepEqual(source, before)
})

test('shared text styles bring their font resources even before style materialization', () => {
  const { source, root, child } = fixture(),
    target = blank()
  source.fonts = { custom: { family: 'Custom', data: 'dGVzdA==' } }
  source.designSystem!.styles.text = {
    name: 'Text',
    kind: 'text',
    value: { ...defaultTextStyle(), fontId: 'custom' },
  }
  child.kind = 'text'
  child.styleRefs = { textStyle: 'text' }
  importDefinitions(target, source, root.id)
  assert.deepEqual(target.fonts?.custom, source.fonts.custom)
  target.fonts!.custom.family = 'Local name'
  assert.equal(source.fonts.custom.family, 'Custom')
})

test('plain-layer copy shares a dependency map across selected nodes and imports no unrelated definitions', () => {
  const { source, child } = fixture(),
    target = blank(),
    other = structuredClone(child)
  other.id = node('rectangle').id
  const copies = [structuredClone(child), other]
  const ids = new Map(copies.map((n) => [n.id, node('rectangle').id]))
  const dependencies = importClipboardDependencies(target, source, copies, ids)
  for (const n of copies) {
    remapReferences(n, dependencies.nodeIds, source)
    remapDesignDependencies(n, dependencies.designSystem)
    n.id = ids.get(n.id)!
    target.nodes[n.id] = n
    target.pages[0].children.push(n.id)
  }
  assert.equal(Object.keys(target.nodes).length, 2)
  assert.equal(target.pages.length, 1)
  assert.equal(copies[0].bindings!['fills.0.color'], copies[1].bindings!['fills.0.color'])
  assert.equal(variableValue(target.designSystem!, copies[0].bindings!['fills.0.color']), '#0000ff')
})

test('a component ID colliding with a destination page is also remapped', () => {
  const { source, root } = fixture(),
    target = blank()
  target.pages[0].id = root.id
  const imported = importDefinitions(target, source, root.id)
  assert.notEqual(imported, root.id)
  assert.ok(target.nodes[imported]?.component)
  assert.equal(target.nodes[root.id], undefined)
})

test('literal text properties equal to a component UUID are not imported as dependencies', () => {
  const { source, root } = fixture(),
    unused = node('frame'),
    outer = node('frame')
  unused.component = { variants: {}, properties: {} }
  outer.component = { variants: {}, properties: {} }
  source.nodes[unused.id] = unused
  source.nodes[outer.id] = outer
  source.pages[0].children.push(unused.id, outer.id)
  root.component!.properties.caption = {
    name: 'Caption',
    kind: 'text',
    targetKey: source.nodes[root.children[0]].componentKey!,
    defaultValue: '',
  }
  const nested = insertInstance(source, root.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  source.nodes[nested].instance!.propertyValues.caption = unused.id
  stampKeys(source, outer.id)
  const target = blank()
  importDefinitions(target, source, outer.id)
  assert.equal(target.nodes[unused.id], undefined)
  assert.equal(target.nodes[nested].instance!.propertyValues.caption, unused.id)
})

test('instance reference edits are captured alongside direct-value overrides', () => {
  const { source, root } = fixture()
  const owner = insertInstance(source, root.id, source.pages[0].id, { x: 0, y: 0 })
  const derived = node('rectangle')
  derived.instanceOrigin = { owner, key: 'child', source: root.children[0] }
  source.nodes[derived.id] = derived
  source.nodes[owner].children = [derived.id]
  const target = structuredClone(source)
  target.nodes[derived.id].bindings = { width: 'width-token' }
  target.nodes[derived.id].styleRefs = { fills: 'shared-fill' }
  target.nodes[derived.id].width = 37
  captureOverrides(source, target)
  assert.deepEqual(target.nodes[owner].instance!.overrides.child.bindings, { width: 'width-token' })
  assert.deepEqual(target.nodes[owner].instance!.overrides.child.styleRefs, {
    fills: 'shared-fill',
  })
  assert.equal(target.nodes[owner].instance!.overrides.child.width, 37)
})

test('dependencies referenced only inside nested instance overrides are copied and remapped', () => {
  const { source, root } = fixture(),
    outer = node('frame')
  outer.component = { variants: {}, properties: {} }
  source.nodes[outer.id] = outer
  source.pages[0].children.push(outer.id)
  const nested = insertInstance(source, root.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  source.nodes[nested].instance!.overrides['$root'] = {
    bindings: { opacity: 'override-opacity' },
    styleRefs: { fills: 'override-fill' },
  }
  source.designSystem!.variables['override-opacity'] = {
    name: 'Override opacity',
    kind: 'number',
    collection: 'theme',
    values: { day: 0.3, night: 0.7 },
  }
  source.designSystem!.styles['override-fill'] = {
    name: 'Override fill',
    kind: 'paint',
    value: [paint('#fedcba')],
  }
  stampKeys(source, outer.id)
  const target = structuredClone(source),
    before = structuredClone(source)
  target.id = blank().id
  const imported = importDefinitions(target, source, outer.id)
  const copiedNested = target.nodes[target.nodes[imported].children[0]]
  const fields = copiedNested.instance!.overrides['$root']
  const variable = (fields.bindings as Record<string, string>).opacity
  const style = (fields.styleRefs as Record<string, string>).fills
  assert.notEqual(variable, 'override-opacity')
  assert.notEqual(style, 'override-fill')
  assert.equal(variableValue(target.designSystem!, variable), 0.7)
  assert.deepEqual(target.designSystem!.styles[style], source.designSystem!.styles['override-fill'])
  assert.deepEqual(source, before)
})

test('nested instance text-style and rich-run override fonts remain in the copied closure', () => {
  const { source, root, child } = fixture(),
    outer = node('frame')
  child.kind = 'text'
  source.fonts = {
    styleFont: { family: 'Style font', data: 'c3R5bGU=' },
    runFont: { family: 'Run font', data: 'cnVu' },
  }
  outer.component = { variants: {}, properties: {} }
  source.nodes[outer.id] = outer
  source.pages[0].children.push(outer.id)
  const nested = insertInstance(source, root.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  source.nodes[nested].instance!.overrides[child.componentKey!] = {
    textStyle: { ...defaultTextStyle(), fontId: 'styleFont' },
    textRuns: [{ start: 0, end: 1, fontId: 'runFont' }],
  }
  stampKeys(source, outer.id)
  const target = blank()
  importDefinitions(target, source, outer.id)
  assert.deepEqual(target.fonts, source.fonts)
})

test('authored-only deep nested property swaps keep their dependencies and remap them', () => {
  const source = blank(),
    target = blank()
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
    alternateLeaf = main(),
    middle = main(),
    outer = main(),
    top = main()
  const slot = insertInstance(source, iconA.id, source.pages[0].id, { x: 0, y: 0 }, leaf.id)
  stampKeys(source, leaf.id)
  leaf.component!.properties.swap = {
    name: 'Icon',
    kind: 'instance-swap',
    targetKey: source.nodes[slot].componentKey!,
    defaultValue: iconA.id,
  }
  const alternateSlot = insertInstance(
    source,
    iconA.id,
    source.pages[0].id,
    { x: 0, y: 0 },
    alternateLeaf.id,
  )
  stampKeys(source, alternateLeaf.id)
  alternateLeaf.component!.properties.alternateSwap = {
    name: 'Alternate icon',
    kind: 'instance-swap',
    targetKey: source.nodes[alternateSlot].componentKey!,
    defaultValue: iconA.id,
  }
  const leafSlot = insertInstance(source, leaf.id, source.pages[0].id, { x: 0, y: 0 }, middle.id)
  stampKeys(source, middle.id)
  middle.component!.properties.pickLeaf = {
    name: 'Leaf',
    kind: 'instance-swap',
    targetKey: source.nodes[leafSlot].componentKey!,
    defaultValue: alternateLeaf.id,
  }
  const middleSlot = insertInstance(source, middle.id, source.pages[0].id, { x: 0, y: 0 }, outer.id)
  stampKeys(source, outer.id)
  const outerSlot = insertInstance(source, outer.id, source.pages[0].id, { x: 0, y: 0 }, top.id)
  stampKeys(source, top.id)
  const path = `${source.nodes[middleSlot].componentKey}/${source.nodes[leafSlot].componentKey}`
  source.nodes[outerSlot].instance!.overrides[path] = {
    propertyValues: { alternateSwap: iconB.id },
  }
  target.nodes[iconB.id] = structuredClone(iconA)
  target.nodes[iconB.id].id = iconB.id
  target.pages[0].children.push(iconB.id)
  importDefinitions(target, source, top.id)
  const copiedSlot = target.nodes[outerSlot]
  const swapped = (copiedSlot.instance!.overrides[path].propertyValues as Record<string, string>)
    .alternateSwap
  assert.notEqual(swapped, iconB.id)
  assert.ok(target.nodes[swapped]?.component)
})
