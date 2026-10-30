import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, effect, node, paint, validateDocument, type DesignNode } from './model'
import {
  emptySystem,
  installLibrary,
  importDesignDependencies,
  publishLibrary,
  setNodeVariableMode,
  effectiveNodeVariableModes,
  setEffectiveNodeVariableMode,
  variableValue,
} from './design-system'
import { insertInstance, setOverride, stampKeys } from './components'
import { originNode } from './component-fixtures'
import { createDocumentHistory, kernelLayout, prepareDocumentForEditing } from './kernel/picking'

function fixture() {
  const doc = blank('Local modes')
  doc.schemaVersion = 4
  const parent = node('frame', 0, 0, 200, 200),
    other = node('frame', 300, 0, 200, 200),
    child = node('rectangle', 0, 0, 20, 20)
  doc.nodes = Object.fromEntries([parent, other, child].map((n) => [n.id, n]))
  doc.pages[0].children = [parent.id, other.id]
  parent.children = [child.id]
  child.bindings = { width: 'size' }
  const system = (doc.designSystem = emptySystem())
  system.collections.theme = { name: 'Theme', modes: ['day', 'night'], defaultMode: 'day' }
  system.variables.size = {
    name: 'Size',
    collection: 'theme',
    kind: 'number',
    values: { day: 20, night: 80 },
  }
  return { doc, parent, other, child }
}
function componentFixture() {
  const f = fixture()
  f.parent.component = { properties: {}, variants: {} }
  stampKeys(f.doc, f.parent.id)
  const instance = insertInstance(
    f.doc,
    f.parent.id,
    f.doc.pages[0].id,
    { x: 320, y: 20 },
    f.other.id,
  )
  return { ...f, instance }
}
const mode = (editor: Editor, id: string, value?: string) =>
  editor.change('Set local mode', (d) => setNodeVariableMode(d, id, 'theme', value))
const width = (editor: Editor, id: string) => editor.state.doc.nodes[id].width

test.each([1, 2, 3, 4, 5, 6] as const)(
  'schema %i remains readable without new mode semantics',
  (version) => {
    const doc = blank()
    doc.schemaVersion = version
    const n = node('rectangle')
    n.variableModes = {}
    doc.nodes[n.id] = n
    doc.pages[0].children = [n.id]
    const loaded = prepareDocumentForEditing(JSON.parse(JSON.stringify(doc)))
    expect(loaded.schemaVersion).toBe(Math.max(2, version))
    createDocumentHistory(doc).free()
  },
)

test.each([1, 2, 3, 4, 5] as const)(
  'schema %i rejects nonempty local maps and explicit empty overrides',
  (version) => {
    const { doc, parent, instance } = componentFixture()
    doc.schemaVersion = version
    parent.variableModes = { theme: 'night' }
    expect(() => validateDocument(doc)).toThrow('版本 6')
    expect(() => prepareDocumentForEditing(doc)).toThrow('版本 6')
    delete parent.variableModes
    doc.nodes[instance].instance!.overrides.$root = { variableModes: {} }
    expect(() => validateDocument(doc)).toThrow('版本 6')
    expect(() => prepareDocumentForEditing(doc)).toThrow('版本 6')
  },
)

test('local modes inherit through parents, beat document modes, clear, reparent and undo atomically', () => {
  const { doc, parent, other, child } = fixture(),
    editor = new Editor(doc)
  expect(width(editor, child.id)).toBe(20)
  const before = structuredClone(editor.state.doc)
  editor.update([parent.id], { variableModes: { theme: 'night' } })
  expect(editor.state.doc.schemaVersion, editor.state.message).toBe(6)
  expect(width(editor, child.id)).toBe(80)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.redo()
  expect(width(editor, child.id)).toBe(80)
  // This parent has no bindings: clearing it used to satisfy the layout fast path.
  editor.update([parent.id], { variableModes: undefined })
  expect(width(editor, child.id), editor.state.message).toBe(20)
  expect(editor.state.doc.schemaVersion).toBe(6)
  mode(editor, parent.id, 'night')
  editor.update([parent.id], { variableModes: {} })
  expect(width(editor, child.id)).toBe(20)
  mode(editor, parent.id, 'night')
  mode(editor, child.id, 'day')
  expect(width(editor, child.id)).toBe(20)
  mode(editor, child.id)
  expect(width(editor, child.id)).toBe(80)
  editor.reparent(child.id, other.id)
  expect(width(editor, child.id)).toBe(20)
  editor.undo()
  expect(width(editor, child.id)).toBe(80)
  editor.redo()
  expect(width(editor, child.id)).toBe(20)
  editor.change('Document fallback', (d) => {
    d.designSystem!.activeModes.theme = 'night'
  })
  expect(width(editor, child.id)).toBe(80)
  mode(editor, other.id, 'day')
  expect(width(editor, child.id)).toBe(20)
  const reloaded = prepareDocumentForEditing(JSON.parse(JSON.stringify(editor.state.doc)))
  expect(reloaded).toEqual(editor.state.doc)
  expect(kernelLayout(reloaded)).toEqual(reloaded)
})

test('cross-collection aliases use the same effective ancestor and node mode context', () => {
  const { doc, parent, child } = fixture(),
    s = doc.designSystem!
  s.collections.tokens = { name: 'Tokens', modes: ['small', 'large'], defaultMode: 'small' }
  s.variables.token = {
    name: 'Token',
    collection: 'tokens',
    kind: 'number',
    values: { small: 17, large: 91 },
  }
  s.variables.size.values = { day: { alias: 'token' }, night: 80 }
  parent.variableModes = { tokens: 'large' }
  doc.schemaVersion = 6
  const editor = new Editor(doc)
  expect(width(editor, child.id)).toBe(91)
  editor.update([child.id], { variableModes: { tokens: 'small' } })
  expect(width(editor, child.id)).toBe(17)
  mode(editor, parent.id, 'night')
  expect(width(editor, child.id)).toBe(80)
})

test('preview commits local mode promotion and cancellation restores the previous snapshot', () => {
  const { doc, parent, child } = fixture(),
    editor = new Editor(doc)
  const before = editor.state.doc
  editor.begin('Preview mode')
  editor.preview({ [parent.id]: { variableModes: { theme: 'night' } } })
  expect(width(editor, child.id), editor.state.message).toBe(80)
  expect(editor.state.doc.schemaVersion).toBe(6)
  editor.cancel()
  expect(editor.state.doc).toBe(before)
  editor.begin('Preview mode')
  editor.preview({ [parent.id]: { variableModes: { theme: 'night' } } })
  editor.commit()
  expect(width(editor, child.id)).toBe(80)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('material edits and removing modes never downgrade schema 6', () => {
  const { doc, parent } = fixture(),
    editor = new Editor(doc)
  mode(editor, parent.id, 'night')
  editor.update([parent.id], { effects: [effect('glass')] })
  expect(editor.state.doc.schemaVersion, editor.state.message).toBe(6)
  mode(editor, parent.id)
  expect(editor.state.doc.schemaVersion).toBe(6)
  expect(() => prepareDocumentForEditing(editor.state.doc)).not.toThrow()
})

test.each([null, [], 'night', 1, { missing: 'day' }, { theme: 'missing' }, { theme: 1 }])(
  'invalid local mode map %j is rejected in validation and as an atomic edit',
  (invalid) => {
    const { doc, parent, instance } = componentFixture()
    const editor = new Editor(doc),
      before = editor.state.doc
    const invalidDocument = structuredClone(doc)
    invalidDocument.schemaVersion = 6
    invalidDocument.nodes[parent.id].variableModes =
      invalid as unknown as DesignNode['variableModes']
    expect(() => validateDocument(invalidDocument)).toThrow()
    editor.update([parent.id], { variableModes: invalid as unknown as DesignNode['variableModes'] })
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    editor.change('Invalid override', (d) =>
      setOverride(d, instance, '$root', { variableModes: invalid }),
    )
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
  },
)

test('mode-only nodes require their collections and reject oversized local maps', () => {
  const { doc, parent } = fixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'night' }
  delete doc.designSystem
  expect(() => validateDocument(doc)).toThrow('局部变量模式')
  const s = (doc.designSystem = emptySystem())
  parent.variableModes = {}
  for (let i = 0; i < 129; i++) {
    s.collections[`c${i}`] = { name: `C${i}`, modes: ['m'], defaultMode: 'm' }
    parent.variableModes[`c${i}`] = 'm'
  }
  expect(() => validateDocument(doc)).toThrow('局部变量模式')
})

test('instance root keeps only authored placement modes through template edits, override clearing and reset', () => {
  const { doc, parent, child, instance } = componentFixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'night' }
  const editor = new Editor(doc)
  const generated = originNode(editor.state.doc, instance, child.componentKey!).id
  expect(editor.state.doc.nodes[instance].variableModes).toBeUndefined()
  expect(width(editor, generated)).toBe(80)
  mode(editor, parent.id, 'day')
  expect(width(editor, generated)).toBe(20)
  expect(editor.state.doc.nodes[instance].variableModes).toBeUndefined()
  mode(editor, parent.id, 'night')
  mode(editor, instance, 'day')
  expect(width(editor, generated)).toBe(20)
  expect(editor.state.doc.nodes[instance].instance!.overrides.$root?.variableModes).toBeUndefined()
  editor.change('Root override', (d) =>
    setOverride(d, instance, '$root', { variableModes: { theme: 'night' } }),
  )
  expect(width(editor, generated)).toBe(80)
  expect(editor.state.doc.nodes[instance].variableModes).toEqual({ theme: 'day' })
  const reloaded = prepareDocumentForEditing(JSON.parse(JSON.stringify(editor.state.doc)))
  expect(reloaded.nodes[instance].variableModes).toEqual({ theme: 'day' })
  expect(reloaded.nodes[generated].width).toBe(80)
  editor.load(reloaded)
  editor.change('Clear root override', (d) => {
    delete d.nodes[instance].instance!.overrides.$root
  })
  expect(width(editor, generated)).toBe(20)
  expect(editor.state.doc.nodes[instance].instance!.overrides.$root).toBeUndefined()
  editor.resetInstance(instance)
  expect(editor.state.doc.nodes[instance].variableModes).toBeUndefined()
  expect(width(editor, generated)).toBe(80)
  editor.undo()
  expect(editor.state.doc.nodes[instance].variableModes).toEqual({ theme: 'day' })
  expect(width(editor, generated)).toBe(20)
  // New insertion must not freeze the main component's current choice locally.
  const added = editor.insertComponent(parent.id)
  expect(editor.state.doc.nodes[added].variableModes).toBeUndefined()
  mode(editor, parent.id, 'day')
  expect(originNode(editor.state.doc, added, child.componentKey!).width).toBe(20)
})

test('empty root mode override replaces component and placement modes and inherits the placement parent', () => {
  const { doc, parent, other, child, instance } = componentFixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'day' }
  other.variableModes = { theme: 'night' }
  doc.nodes[instance].variableModes = { theme: 'day' }
  setOverride(doc, instance, '$root', { variableModes: {} })
  const editor = new Editor(doc)
  const generated = originNode(editor.state.doc, instance, child.componentKey!).id
  expect(width(editor, generated)).toBe(80)
  expect(editor.state.doc.nodes[instance].variableModes).toEqual({ theme: 'day' })
  mode(editor, other.id, 'day')
  expect(width(editor, generated)).toBe(20)
})

test('generated child mode edits and clearing are captured, and reset restores the template', () => {
  const { doc, child, instance } = componentFixture()
  doc.schemaVersion = 6
  child.variableModes = { theme: 'night' }
  const editor = new Editor(doc)
  const generated = originNode(editor.state.doc, instance, child.componentKey!).id
  expect(width(editor, generated)).toBe(80)
  mode(editor, generated, 'day')
  expect(width(editor, generated)).toBe(20)
  expect(
    editor.state.doc.nodes[instance].instance!.overrides[child.componentKey!].variableModes,
  ).toEqual({ theme: 'day' })
  mode(editor, generated)
  expect(width(editor, generated)).toBe(20)
  expect(
    editor.state.doc.nodes[instance].instance!.overrides[child.componentKey!].variableModes,
  ).toEqual({})
  expect(
    prepareDocumentForEditing(JSON.parse(JSON.stringify(editor.state.doc))).nodes[generated].width,
  ).toBe(20)
  editor.resetInstance(generated)
  expect(width(editor, generated)).toBe(80)
  editor.undo()
  expect(width(editor, generated)).toBe(20)
})

test('mode-only cross-document paste imports colliding collections without unrelated variables', () => {
  const { doc, other } = fixture()
  doc.schemaVersion = 6
  other.variableModes = { theme: 'night' }
  const editor = new Editor(doc),
    source = editor.state.doc,
    beforeSource = structuredClone(editor.state.doc)
  editor.select([other.id])
  editor.copy()
  const target = blank('Target')
  target.schemaVersion = 4
  target.designSystem = emptySystem()
  target.designSystem.collections.theme = { name: 'Existing', modes: ['day'], defaultMode: 'day' }
  target.designSystem.activeModes.theme = 'day'
  editor.load(target)
  const before = structuredClone(editor.state.doc)
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted, editor.state.message).toBeDefined()
  const collection = Object.keys(pasted.variableModes!)[0]
  expect(collection).not.toBe('theme')
  expect(pasted.variableModes![collection]).toBe('night')
  expect(editor.state.doc.designSystem!.collections[collection].modes).toEqual(['day', 'night'])
  expect(editor.state.doc.designSystem!.variables).toEqual({})
  expect(editor.state.doc.designSystem!.collections.theme).toEqual(
    before.designSystem!.collections.theme,
  )
  expect(source).toEqual(beforeSource)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.redo()
  expect(editor.state.doc.nodes[pasted.id].variableModes).toEqual(pasted.variableModes)
})

test('override-only mode references and bound aliases share collision remapping when pasted', () => {
  const { doc, child, instance } = componentFixture()
  doc.schemaVersion = 6
  doc.designSystem!.collections.onlyOverride = {
    name: 'Only override',
    modes: ['m'],
    defaultMode: 'm',
  }
  doc.designSystem!.variables.alias = {
    ...doc.designSystem!.variables.size,
    values: { day: { alias: 'size' }, night: { alias: 'size' } },
  }
  child.bindings = { width: 'alias' }
  setOverride(doc, instance, '$root', { variableModes: { theme: 'night', onlyOverride: 'm' } })
  const editor = new Editor(doc),
    source = editor.state.doc,
    beforeSource = structuredClone(source)
  editor.select([instance])
  editor.copy()
  const target = structuredClone(source)
  target.id = blank().id
  editor.load(target)
  const before = structuredClone(editor.state.doc)
  editor.paste()
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted?.instance, editor.state.message).toBeDefined()
  const modes = pasted.instance!.overrides.$root.variableModes as Record<string, string>
  expect(modes.theme).toBeUndefined()
  expect(modes.onlyOverride).toBeUndefined()
  expect(Object.values(modes).sort()).toEqual(['m', 'night'])
  const generated = originNode(editor.state.doc, pasted.id, child.componentKey!)
  expect(generated.width).toBe(80)
  const s = editor.state.doc.designSystem!,
    alias = s.variables[generated.bindings!.width]
  expect(alias.collection).not.toBe('theme')
  expect(modes[alias.collection]).toBe('night')
  expect(s.collections[Object.keys(modes).find((id) => modes[id] === 'm')!].name).toBe(
    'Only override',
  )
  expect(editor.state.doc.nodes[instance]).toEqual(before.nodes[instance])
  expect(source).toEqual(beforeSource)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('library install and upgrade namespace local modes plus override bindings and styles together', async () => {
  const { doc, parent, child } = fixture()
  doc.schemaVersion = 6
  parent.component = { variants: {}, properties: {} }
  parent.variableModes = { theme: 'night' }
  stampKeys(doc, parent.id)
  const outer = node('frame')
  outer.component = { variants: {}, properties: {} }
  doc.nodes[outer.id] = outer
  doc.pages[0].children.push(outer.id)
  const nested = insertInstance(doc, parent.id, doc.pages[0].id, { x: 0, y: 0 }, outer.id)
  doc.nodes[nested].variableModes = { theme: 'day' }
  doc.designSystem!.styles.fill = { name: 'Fill', kind: 'paint', value: [paint('#abcdef')] }
  setOverride(doc, nested, '$root', {
    variableModes: { theme: 'night' },
    bindings: { width: 'size' },
    styleRefs: { fills: 'fill' },
  })
  stampKeys(doc, outer.id)
  const sourceBefore = structuredClone(doc),
    editor = new Editor(blank('Consumer'))
  for (const version of [1, 2]) {
    if (version === 2) doc.designSystem!.variables.size.values.night = 95
    const pkg = await publishLibrary(doc, version)
    editor.change('Install library', (d) => installLibrary(d, pkg))
    const installed = editor.state.doc.designSystem?.libraries[doc.id]
    expect(installed?.version, editor.state.message).toBe(version)
    const local = editor.state.doc.nodes[installed!.nodeMap[nested]]
    expect(local.variableModes).toEqual({ [`${doc.id}/theme`]: 'day' })
    expect(local.instance!.overrides.$root).toMatchObject({
      variableModes: { [`${doc.id}/theme`]: 'night' },
      bindings: { width: `${doc.id}/size` },
      styleRefs: { fills: `${doc.id}/fill` },
    })
    expect(local.width).toBe(version === 1 ? 80 : 95)
    expect(local.fills[0].color).toBe('#abcdef')
    expect(originNode(editor.state.doc, local.id, child.componentKey!).width).toBe(
      version === 1 ? 80 : 95,
    )
    expect(editor.state.doc.schemaVersion).toBe(6)
  }
  sourceBefore.designSystem!.variables.size.values.night = 95
  expect(doc).toEqual(sourceBefore)
  const reloaded = prepareDocumentForEditing(JSON.parse(JSON.stringify(editor.state.doc)))
  expect(reloaded).toEqual(editor.state.doc)
  editor.undo()
  expect(editor.state.doc.designSystem!.libraries[doc.id].version).toBe(1)
  editor.redo()
  expect(editor.state.doc.designSystem!.libraries[doc.id].version).toBe(2)
})

test.each(['detach', 'delete-definition'] as const)(
  '%s preserves effective root-local modes without baking ancestor choices',
  (operation) => {
    const { doc, parent, child, instance } = componentFixture()
    doc.schemaVersion = 6
    parent.variableModes = { theme: 'night' }
    const editor = new Editor(doc)
    const generated = originNode(editor.state.doc, instance, child.componentKey!).id
    if (operation === 'detach') editor.detachInstance(instance)
    else {
      editor.select([parent.id])
      editor.remove()
    }
    expect(editor.state.doc.nodes[instance].instance, editor.state.message).toBeUndefined()
    expect(editor.state.doc.nodes[instance].variableModes).toEqual({ theme: 'night' })
    expect(width(editor, generated)).toBe(80)
    expect(
      prepareDocumentForEditing(JSON.parse(JSON.stringify(editor.state.doc))).nodes[generated]
        .width,
    ).toBe(80)
    editor.undo()
    expect(editor.state.doc.nodes[instance].instance).toBeDefined()
    expect(editor.state.doc.nodes[instance].variableModes).toBeUndefined()
  },
)

test('copying a generated nested instance keeps template defaults live and lifts explicit mode overrides', () => {
  const { doc, parent, other, child, instance } = componentFixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'night' }
  other.component = { variants: {}, properties: {} }
  stampKeys(doc, other.id)
  const outer = insertInstance(doc, other.id, doc.pages[0].id, { x: 600, y: 0 })
  const key = doc.nodes[instance].componentKey!
  const editor = new Editor(doc)
  const generated = originNode(editor.state.doc, outer, key)
  expect(generated.variableModes).toEqual({ theme: 'night' })
  editor.select([generated.id])
  editor.copy()
  editor.paste()
  const copied = editor.state.selection[0]
  expect(editor.state.doc.nodes[copied].variableModes, editor.state.message).toBeUndefined()
  mode(editor, parent.id, 'day')
  expect(originNode(editor.state.doc, copied, child.componentKey!).width).toBe(20)
  editor.change('Outer override', (d) =>
    setOverride(d, outer, key, { variableModes: { theme: 'night' } }),
  )
  editor.select([generated.id])
  editor.copy()
  editor.paste()
  const overridden = editor.state.selection[0]
  expect(editor.state.doc.nodes[overridden].variableModes).toBeUndefined()
  expect(editor.state.doc.nodes[overridden].instance!.overrides.$root.variableModes).toEqual({
    theme: 'night',
  })
  expect(originNode(editor.state.doc, overridden, child.componentKey!).width).toBe(80)
  editor.change('Clear lifted override', (d) => {
    delete d.nodes[overridden].instance!.overrides.$root
  })
  expect(originNode(editor.state.doc, overridden, child.componentKey!).width).toBe(20)
})

test('empty mode overrides require a design system and invalid previews are not published', () => {
  const { doc, parent, child, instance } = componentFixture()
  delete child.bindings
  delete doc.designSystem
  doc.schemaVersion = 6
  setOverride(doc, instance, '$root', { variableModes: {} })
  expect(() => validateDocument(doc)).toThrow('设计系统')
  expect(() => kernelLayout(doc)).toThrow('设计系统')
  delete doc.nodes[instance].instance!.overrides.$root
  const editor = new Editor(doc),
    before = editor.state.doc
  editor.begin('Invalid preview')
  editor.preview({ [parent.id]: { variableModes: { theme: 'night' } } })
  expect(editor.state.doc).toBe(before)
  editor.preview({ [parent.id]: { variableModes: null as unknown as Record<string, string> } })
  expect(editor.state.doc).toBe(before)
  editor.cancel()
})

test('direct design dependency and library imports promote schema when local modes are introduced', async () => {
  const { doc, parent } = fixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'night' }
  parent.component = { variants: {}, properties: {} }
  stampKeys(doc, parent.id)
  const target = blank('Direct dependency import')
  const map = importDesignDependencies(target, doc, [parent])
  expect(target.schemaVersion).toBe(6)
  expect(map.collections.get('theme')).toBe('theme')
  const libraryTarget = blank('Direct library install')
  installLibrary(libraryTarget, await publishLibrary(doc, 1))
  expect(libraryTarget.schemaVersion).toBe(6)
  expect(() => prepareDocumentForEditing(libraryTarget)).not.toThrow()
})

test('effective root-mode editing reflects replacing overrides and preserves unrelated choices', () => {
  const { doc, parent, other, child, instance } = componentFixture()
  doc.schemaVersion = 6
  parent.variableModes = { theme: 'day' }
  other.variableModes = { theme: 'night' }
  doc.nodes[instance].variableModes = { theme: 'day' }
  doc.designSystem!.collections.other = { name: 'Other', modes: ['m'], defaultMode: 'm' }
  setOverride(doc, instance, '$root', {
    variableModes: { theme: 'night', other: 'm' },
    name: 'Custom',
  })
  const editor = new Editor(doc)
  const generated = originNode(editor.state.doc, instance, child.componentKey!).id
  expect(effectiveNodeVariableModes(editor.state.doc.nodes[instance])).toEqual({
    theme: 'night',
    other: 'm',
  })
  editor.change('Effective day', (d) => setEffectiveNodeVariableMode(d, instance, 'theme', 'day'))
  expect(width(editor, generated)).toBe(20)
  expect(effectiveNodeVariableModes(editor.state.doc.nodes[instance])).toEqual({
    theme: 'day',
    other: 'm',
  })
  editor.change('Effective inherit', (d) => setEffectiveNodeVariableMode(d, instance, 'theme'))
  expect(width(editor, generated)).toBe(80)
  expect(effectiveNodeVariableModes(editor.state.doc.nodes[instance])).toEqual({ other: 'm' })
  expect(editor.state.doc.nodes[instance].variableModes).toEqual({ theme: 'day' })
  expect(editor.state.doc.nodes[instance].instance!.overrides.$root.name).toBe('Custom')
  editor.undo()
  expect(width(editor, generated)).toBe(20)
})

test('empty-string mode names retain selected values when resolved, edited and copied', () => {
  const { doc, parent, child } = fixture(),
    system = doc.designSystem!
  system.collections.theme.modes.push('')
  system.variables.size.values[''] = 42
  system.activeModes.theme = ''
  const editor = new Editor(doc)
  expect(width(editor, child.id)).toBe(42)
  expect(variableValue(system, 'size')).toBe(42)
  editor.change('Empty local mode', (d) => setEffectiveNodeVariableMode(d, parent.id, 'theme', ''))
  expect(editor.state.doc.nodes[parent.id].variableModes).toEqual({ theme: '' })
  expect(width(editor, child.id)).toBe(42)
  editor.select([parent.id])
  editor.copy()
  editor.load(blank('Empty mode target'))
  editor.paste()
  const copied = editor.state.doc.nodes[editor.state.selection[0]]
  expect(copied.variableModes, editor.state.message).toEqual({ theme: '' })
  expect(editor.state.doc.designSystem!.activeModes.theme).toBe('')
  expect(editor.state.doc.nodes[copied.children[0]].width).toBe(42)
})
