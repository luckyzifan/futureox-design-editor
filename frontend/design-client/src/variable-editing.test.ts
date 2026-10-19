import { afterEach, expect, test } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Editor } from './engine'
import { blank, node, paint, validateDocument } from './model'
import { emptySystem, variableValue } from './design-system'
import { initialPrototype, prototypeEvent } from './prototype'
import { insertInstance, stampKeys } from './components'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import {
  addVariableMode, collectionReferences, createVariable, createVariableCollection,
  deleteVariable, deleteVariableCollection, deleteVariableMode, materializeVariableCell,
  modeReferences, parseVariableLiteral, renameVariable, renameVariableCollection,
  renameVariableMode, setVariableCell, setVariableDefaultMode, validVariableName,
  variableGroup, variableIndex, variableReferences,
} from './variable-editing'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function makeEditor(doc: ReturnType<typeof blank>) { const editor = new Editor(doc); editors.push(editor); return editor }
function fixture() {
  const doc = blank('Variable management'), parent = node('frame', 0, 0, 200, 100), child = node('rectangle', 0, 0, 20, 20)
  parent.name = 'Card'; child.name = 'Content'; parent.children = [child.id]
  doc.nodes = { [parent.id]: parent, [child.id]: child }; doc.pages[0].children = [parent.id]
  doc.designSystem = emptySystem(); doc.schemaVersion = 6
  const s = doc.designSystem
  s.collections.theme = { name: 'Theme', modes: ['Light', 'Dark'], defaultMode: 'Light' }; s.activeModes.theme = 'Light'
  s.variables.size = { name: 'Spacing/base', kind: 'number', collection: 'theme', values: { Light: 17.125, Dark: 83.75 } }
  s.variables.alias = { name: 'Spacing/alias', kind: 'number', collection: 'theme', values: { Light: { alias: 'size' }, Dark: { alias: 'size' } } }
  s.variables.color = { name: 'Colors/brand', kind: 'color', collection: 'theme', values: { Light: '#123456', Dark: '#654321' } }
  child.bindings = { width: 'alias', 'fills.0.color': 'color' }; child.fills = [paint('#ffffff')]
  return { doc, parent, child }
}

test('editing an inactive alias cell materializes that column and leaves cross-collection context intact', () => {
  const { doc } = fixture(), s = doc.designSystem!
  s.collections.tokens = { name: 'Tokens', modes: ['small', 'large'], defaultMode: 'small' }
  s.activeModes.tokens = 'large'
  s.variables.token = { name: 'Token', kind: 'number', collection: 'tokens', values: { small: 2.25, large: 97.875 } }
  const editor = makeEditor(doc), before = editor.state.doc
  editor.change('Materialize Dark', d => materializeVariableCell(d, 'alias', 'Dark'))
  expect(editor.state.doc.designSystem!.variables.alias.values).toEqual({ Light: { alias: 'size' }, Dark: 83.75 })
  expect(editor.state.doc.designSystem!.activeModes.theme).toBe('Light')
  editor.undo(); expect(editor.state.doc).toEqual(before); editor.redo()
  editor.change('Cross collection', d => { setVariableCell(d, 'alias', 'Dark', { alias: 'token' }); materializeVariableCell(d, 'alias', 'Dark') })
  expect(editor.state.doc.designSystem!.variables.alias.values.Dark).toBe(97.875)
})

test('mode rename remaps defaults, active mode, every value, inherited modes and instance overrides atomically', () => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; stampKeys(doc, parent.id)
  const instance = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 })
  parent.variableModes = { theme: 'Dark' }
  doc.nodes[instance].variableModes = { theme: 'Light' }
  doc.nodes[instance].instance!.overrides.$root = { variableModes: { theme: 'Dark' } }
  doc.nodes[instance].instance!.overrides[child.componentKey!] = { variableModes: { theme: 'Dark' } }
  doc.designSystem!.activeModes.theme = 'Dark'; doc.designSystem!.collections.theme.defaultMode = 'Dark'
  const editor = makeEditor(doc), before = editor.state.doc
  const widths = Object.fromEntries(Object.entries(before.nodes).map(([id, n]) => [id, n.width]))
  editor.change('Rename Dark', d => renameVariableMode(d, 'theme', 'Dark', 'Night'))
  const after = editor.state.doc, s = after.designSystem!
  expect(s.collections.theme, editor.state.message).toEqual({ name: 'Theme', modes: ['Light', 'Night'], defaultMode: 'Night' })
  expect(s.activeModes.theme).toBe('Night')
  expect(s.variables.size.values.Night).toBe(83.75); expect(s.variables.size.values).not.toHaveProperty('Dark')
  expect(after.nodes[parent.id].variableModes?.theme).toBe('Night')
  expect(after.nodes[instance].variableModes?.theme).toBe('Light')
  expect(after.nodes[instance].instance!.overrides.$root.variableModes).toEqual({ theme: 'Night' })
  expect(after.nodes[instance].instance!.overrides[child.componentKey!].variableModes).toEqual({ theme: 'Night' })
  expect(Object.fromEntries(Object.entries(after.nodes).map(([id, n]) => [id, n.width]))).toEqual(widths)
  editor.undo(); expect(editor.state.doc).toEqual(before); editor.redo(); expect(editor.state.doc).toEqual(after)
  expect(validateDocument(after)).toBeTruthy()
})

test('mode rename scopes prototype target and VariableData mode references independently', () => {
  const { doc, child } = fixture(); doc.schemaVersion = 12
  doc.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
  doc.designSystem!.variables.other = { name: 'Other', kind: 'number', collection: 'other', values: { Light: 1, Dark: 2 } }
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', actions: [
    { kind: 'set-variable', target: 'size', value: 30, targetVariableModeId: 'Dark' },
    { kind: 'set-variable', target: 'size', targetVariable: 'size', targetVariableData: { id: 'other', modeId: 'Dark' }, targetVariableModeId: 'Dark', value: 30 },
    { kind: 'set-variable', target: 'other', targetVariable: 'other', targetVariableData: { id: 'size', modeId: 'Dark' }, targetVariableModeId: 'Dark', value: 30 },
  ] }] } }
  const editor = makeEditor(doc)
  editor.change('Rename mode', d => renameVariableMode(d, 'theme', 'Dark', 'Night'))
  const actions = editor.state.doc.prototype!.interactions[child.id][0].actions
  expect(actions[0].targetVariableModeId).toBe('Night')
  expect(actions[1]).toMatchObject({ targetVariableModeId: 'Night', targetVariableData: { modeId: 'Dark' } })
  expect(actions[2]).toMatchObject({ targetVariableModeId: 'Dark', targetVariableData: { modeId: 'Night' } })
})

test('deletion reports alias, node, instance override and prototype dependencies without touching the document', () => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; stampKeys(doc, parent.id)
  const instance = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 })
  doc.nodes[instance].instance!.overrides.$root = { bindings: { width: 'size' } }
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', condition: { variable: 'size', equals: 17.125 }, actions: [{ kind: 'set-variable', target: 'size', value: 23 }] }] } }
  const editor = makeEditor(doc), before = editor.state.doc, references = variableReferences(before, 'size')
  expect(references.some(r => r.includes('别名'))).toBe(true)
  expect(references.some(r => r.includes('覆盖'))).toBe(true)
  expect(references.some(r => r.includes('条件'))).toBe(true)
  expect(references.some(r => r.includes('动作'))).toBe(true)
  editor.change('Unsafe delete', d => deleteVariable(d, 'size'))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false); expect(editor.state.message).toContain('引用')
})

test.each(['targetVariable', 'transitionDurationVar', 'transitionEasingVar', 'targetVariableData', 'target'] as const)('deletion detects prototype field %s even without a visible binding', field => {
  const { doc, child } = fixture()
  const action: any = { kind: 'set-variable', target: 'alias', value: 20 }
  action[field] = field === 'targetVariableData' ? { id: 'size' } : 'size'
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', actions: [action] }] } }
  expect(variableReferences(doc, 'size').some(r => r.includes('动作'))).toBe(true)
})

test('default, active, node and prototype mode references block deletion until explicitly removed', () => {
  const { doc, parent, child } = fixture(); doc.schemaVersion = 12
  parent.variableModes = { theme: 'Dark' }
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', actions: [{ kind: 'set-variable', target: 'size', value: 50, targetVariableModeId: 'Dark' }] }] } }
  const editor = makeEditor(doc), before = editor.state.doc
  expect(modeReferences(before, 'theme', 'Light')).toHaveLength(2)
  expect(modeReferences(before, 'theme', 'Dark')).toHaveLength(2)
  editor.change('Unsafe mode deletion', d => deleteVariableMode(d, 'theme', 'Dark'))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  editor.change('Remove mode references', d => { delete d.nodes[parent.id].variableModes; delete d.prototype })
  editor.change('Delete unused mode', d => deleteVariableMode(d, 'theme', 'Dark'))
  expect(editor.state.doc.designSystem!.collections.theme.modes).toEqual(['Light'])
  expect(editor.state.doc.designSystem!.variables.size.values).toEqual({ Light: 17.125 })
  editor.undo(); expect(editor.state.doc.designSystem!.variables.size.values.Dark).toBe(83.75)
})

test('collection deletion requires empty variables and no local or prototype collection references', () => {
  const { doc, parent, child } = fixture(); doc.schemaVersion = 12
  doc.designSystem!.collections.unused = { name: 'Empty', modes: ['Default'], defaultMode: 'Default' }
  parent.variableModes = { unused: 'Default' }
  doc.prototype = { interactions: { [child.id]: [{ trigger: 'click', actions: [{ kind: 'set-variable', target: 'size', value: 40, targetVariableSetId: 'unused' }] }] } }
  const editor = makeEditor(doc), before = editor.state.doc
  expect(collectionReferences(before, 'unused')).toHaveLength(2)
  editor.change('Cannot delete referenced', d => deleteVariableCollection(d, 'unused')); expect(editor.state.doc).toBe(before)
  editor.change('Remove references', d => { delete d.nodes[parent.id].variableModes; delete d.prototype })
  editor.change('Delete collection', d => deleteVariableCollection(d, 'unused'))
  expect(editor.state.doc.designSystem!.collections).not.toHaveProperty('unused')
  editor.undo(); expect(editor.state.doc.designSystem!.collections.unused).toBeDefined()
})

test('create, rename, default selection, mode copy and safe deletions use the real editor history', () => {
  const editor = makeEditor(blank()), initial = editor.state.doc
  let cid = '', id = ''
  editor.change('Create', d => { cid = createVariableCollection(d, 'Tokens'); id = createVariable(d, cid, 'number') })
  editor.change('Edit', d => { renameVariableCollection(d, cid, 'Spacing'); renameVariable(d, id, 'Spacing/base'); setVariableCell(d, id, 'Dark', 42.125); addVariableMode(d, cid, 'Large', 'Dark'); setVariableDefaultMode(d, cid, 'Large') })
  const s = editor.state.doc.designSystem!
  expect(s.collections[cid].defaultMode).toBe('Large'); expect(s.activeModes[cid]).toBe('Light')
  expect(s.variables[id].values.Large).toBe(42.125)
  editor.change('Delete unused variable', d => deleteVariable(d, id))
  editor.change('Delete empty collection', d => deleteVariableCollection(d, cid))
  expect(editor.state.doc.designSystem!.collections).toEqual({}); expect(editor.state.doc.designSystem!.activeModes).toEqual({})
  for (let i = 0; i < 4; i++) editor.undo()
  expect(editor.state.doc).toEqual(initial)
})

test.each(['', '  ', '__proto__', 'constructor', 'prototype', 'bad\nname', '中'.repeat(171)])('invalid resource name %j is rejected without history', value => {
  const { doc } = fixture(), editor = makeEditor(doc), before = editor.state.doc
  expect(validVariableName(value)).toBe(false)
  editor.change('Invalid name', d => renameVariableMode(d, 'theme', 'Dark', value))
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('duplicate modes, missing copy modes, cycles, wrong kinds and invalid numbers are atomic failures', () => {
  const { doc } = fixture(), editor = makeEditor(doc), before = editor.state.doc
  const invalid = [
    (d: typeof doc) => renameVariableMode(d, 'theme', 'Dark', 'Light'),
    (d: typeof doc) => addVariableMode(d, 'theme', 'New', 'missing'),
    (d: typeof doc) => setVariableCell(d, 'size', 'Light', { alias: 'alias' }),
    (d: typeof doc) => setVariableCell(d, 'size', 'Light', { alias: 'color' }),
    (d: typeof doc) => setVariableCell(d, 'size', 'Light', ''),
    (d: typeof doc) => setVariableCell(d, 'size', 'Light', Infinity),
  ]
  for (const edit of invalid) { editor.change('Invalid', edit); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false) }
})

test('typed literals preserve numeric precision, strict booleans, strings, and supported managed colors', () => {
  expect(parseVariableLiteral('number', '1.23456789012345')).toBe(1.23456789012345)
  expect(parseVariableLiteral('number', '-1.25e-3')).toBe(-.00125)
  expect(() => parseVariableLiteral('number', '0xff')).toThrow()
  expect(() => parseVariableLiteral('boolean', 'no')).toThrow()
  expect(parseVariableLiteral('boolean', 'false')).toBe(false)
  expect(parseVariableLiteral('string', '')).toBe('')
  expect(parseVariableLiteral('color', 'color(display-p3 0.6 0.2 0.1)', true)).toBe('color(display-p3 0.6 0.2 0.1)')
})

test('variable indexes are grouped once, sorted by path, and preserve reference identities', () => {
  const { doc } = fixture(), index = variableIndex(doc.designSystem!)
  expect(index.byCollection.get('theme')!.map(([, v]) => v.name)).toEqual(['Colors/brand', 'Spacing/alias', 'Spacing/base'])
  expect(index.byKind.get('number')).toHaveLength(2)
  expect(index.byKind.get('number')![0][1]).toBe(doc.designSystem!.variables.size)
  expect(variableGroup('Brand/Color/Accent')).toBe('Brand/Color'); expect(variableGroup('Accent')).toBe('未分组')
})

test('edited variables survive real binary disk persistence and reopen through Editor/WASM exactly', async () => {
  const { doc, parent, child } = fixture(), editor = makeEditor(doc)
  editor.change('Persisted edits', d => {
    renameVariableCollection(d, 'theme', 'Saved theme'); renameVariableMode(d, 'theme', 'Dark', 'Night')
    d.nodes[parent.id].variableModes = { theme: 'Night' }; setVariableCell(d, 'size', 'Night', 83.75000000001)
    materializeVariableCell(d, 'alias', 'Night'); addVariableMode(d, 'theme', 'High contrast', 'Night')
  })
  const saved = editor.state.doc, directory = await mkdtemp(join(tmpdir(), 'variables-persist-'))
  try {
    const file = join(directory, 'document.fd'); await writeFile(file, encodeDocumentBinary(saved))
    const reopened = makeEditor(decodeDocumentBinary(new Uint8Array(await readFile(file))) as typeof doc)
    expect(reopened.state.doc).toEqual(saved)
    expect(reopened.state.doc.nodes[child.id].width).toBe(83.75000000001)
    expect(variableValue(reopened.state.doc.designSystem!, 'alias', { theme: 'High contrast' })).toBe(83.75000000001)
    expect(reopened.state.doc.nodes[child.id].fills[0].color).toBe('#654321')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('copying an imported empty-string mode uses that exact source rather than the default', () => {
  const { doc } = fixture(), s = doc.designSystem!
  s.collections.theme.modes = ['', 'Dark']; s.collections.theme.defaultMode = 'Dark'; s.activeModes.theme = 'Dark'
  for (const v of Object.values(s.variables)) { v.values[''] = v.values.Light; delete v.values.Light }
  const e = makeEditor(doc)
  e.change('Copy empty mode', d => addVariableMode(d, 'theme', 'Copied', ''))
  expect(e.state.doc.designSystem!.variables.size.values.Copied).toBe(17.125)
  expect(e.state.doc.designSystem!.variables.alias.values.Copied).toEqual({ alias: 'size' })
  e.change('Rename imported empty mode', d => renameVariableMode(d, 'theme', '', 'Day'))
  expect(e.state.doc.designSystem!.variables.size.values.Day).toBe(17.125)
})

test('mode limit rejects a 33rd column and copied alias objects remain independent', () => {
  const { doc } = fixture(), s = doc.designSystem!
  addVariableMode(doc, 'theme', 'Copied alias', 'Light')
  expect(s.variables.alias.values['Copied alias']).toEqual(s.variables.alias.values.Light)
  expect(s.variables.alias.values['Copied alias']).not.toBe(s.variables.alias.values.Light)
  for (let i = 3; i < 32; i++) addVariableMode(doc, 'theme', `Mode ${i}`)
  const e = makeEditor(doc), before = e.state.doc
  e.change('One too many', d => addVariableMode(d, 'theme', 'Overflow'))
  expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false); expect(e.state.message).toContain('32')
})

test.each(['theme', 'other'])('mixed prototype metadata keeps effective playback when renaming %s modes', collectionId => {
  const { doc, child } = fixture(); doc.schemaVersion = 12
  doc.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
  doc.designSystem!.variables.other = { name: 'Other', kind: 'number', collection: 'other', values: { Light: 1, Dark: 2 } }
  doc.prototype = { startNode: child.id, interactions: { [child.id]: [{ trigger: 'click', actions: [{
    kind: 'set-variable', target: 'size', targetVariable: 'size', targetVariableData: { id: 'other', modeId: 'Dark' }, value: 99,
  }] }] } }
  const e = makeEditor(doc), before = e.state.doc
  const playback = () => prototypeEvent(e.state.doc, initialPrototype(e.state.doc), child.id, 'click')
  expect(playback().modeValues?.size.Dark).toBe(99)
  expect(modeReferences(before, 'theme', 'Dark').some(r => r.includes('动作'))).toBe(true)
  e.change('Do not delete effective fallback mode', d => deleteVariableMode(d, 'theme', 'Dark'))
  expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  e.change('Rename mixed reference', d => renameVariableMode(d, collectionId, 'Dark', 'Night'))
  const mode = collectionId === 'theme' ? 'Night' : 'Dark', action = e.state.doc.prototype!.interactions[child.id][0].actions[0]
  expect(playback().modeValues?.size[mode]).toBe(99)
  expect(action.targetVariableModeId).toBe(mode)
  expect(action.targetVariableData?.modeId).toBe(collectionId === 'other' ? 'Night' : 'Dark')
  e.undo(); expect(e.state.doc).toEqual(before); expect(playback().modeValues?.size.Dark).toBe(99)
  e.redo(); expect(playback().modeValues?.size[mode]).toBe(99)
})

test('mode rename preserves live inherited instance-child modes rather than creating replacement overrides', () => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; child.variableModes = { theme: 'Dark' }; stampKeys(doc, parent.id)
  const instance = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 }), e = makeEditor(doc)
  const generated = Object.values(e.state.doc.nodes).find(n => n.instanceOrigin?.owner === instance && n.instanceOrigin.key === child.componentKey)!.id
  e.change('Rename inherited mode', d => renameVariableMode(d, 'theme', 'Dark', 'Night'))
  expect(e.state.doc.designSystem!.collections.theme.modes, e.state.message).toEqual(['Light', 'Night'])
  expect(e.state.doc.nodes[instance].instance!.overrides[child.componentKey!]).toBeUndefined()
  e.change('Change source mode', d => { d.nodes[child.id].variableModes = { theme: 'Light' } })
  expect(e.state.doc.nodes[generated].width).toBe(17.125)
})

test('renaming inherited and explicit instance modes retains their distinct precedence through later source edits', () => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; child.variableModes = { theme: 'Dark' }; stampKeys(doc, parent.id)
  const inherited = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 })
  const explicit = insertInstance(doc, parent.id, doc.pages[0].id, { x: 600, y: 0 })
  doc.nodes[explicit].instance!.overrides[child.componentKey!] = { variableModes: { theme: 'Dark' } }
  const e = makeEditor(doc), generated = (owner: string) => Object.values(e.state.doc.nodes).find(n => n.instanceOrigin?.owner === owner && n.instanceOrigin.key === child.componentKey)!
  e.change('Rename', d => renameVariableMode(d, 'theme', 'Dark', 'Night'))
  expect(e.state.doc.designSystem!.collections.theme.modes).toEqual(['Light', 'Night'])
  expect(e.state.doc.nodes[inherited].instance!.overrides).toEqual({})
  expect(e.state.doc.nodes[explicit].instance!.overrides[child.componentKey!]).toEqual({ variableModes: { theme: 'Night' } })
  const renamed = e.state.doc
  e.change('Edit template mode', d => { d.nodes[child.id].variableModes = { theme: 'Light' } })
  expect(generated(inherited).width).toBe(17.125); expect(generated(explicit).width).toBe(83.75)
  e.undo(); expect(e.state.doc).toEqual(renamed)
  e.redo(); expect(generated(inherited).width).toBe(17.125); expect(generated(explicit).width).toBe(83.75)
})

test.each([false, true])('intentional generated mode edits still create an override (with rename: %s)', rename => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; child.variableModes = { theme: 'Dark' }; stampKeys(doc, parent.id)
  const instance = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 }), e = makeEditor(doc)
  const generated = Object.values(e.state.doc.nodes).find(n => n.instanceOrigin?.owner === instance && n.instanceOrigin.key === child.componentKey)!.id
  e.change('Explicit child mode', d => {
    if (rename) renameVariableMode(d, 'theme', 'Dark', 'Night')
    d.nodes[generated].variableModes = { theme: 'Light' }
  })
  expect(e.state.doc.nodes[instance].instance!.overrides[child.componentKey!]).toEqual({ variableModes: { theme: 'Light' } })
  expect(e.state.doc.nodes[generated].width).toBe(17.125)
  expect(e.state.doc.nodes[child.id].variableModes?.theme).toBe(rename ? 'Night' : 'Dark')
})

test.each(['mode-reorder', 'value-edit'] as const)('ambiguous %s changes reject atomically instead of freezing inherited modes', ambiguity => {
  const { doc, parent, child } = fixture()
  parent.component = { properties: {}, variants: {} }; child.variableModes = { theme: 'Dark' }; stampKeys(doc, parent.id)
  doc.designSystem!.collections.other = { name: 'Other', modes: ['Light', 'Dark'], defaultMode: 'Light' }
  const instance = insertInstance(doc, parent.id, doc.pages[0].id, { x: 300, y: 0 }), e = makeEditor(doc)
  e.change('Ambiguous compound edit', d => {
    renameVariableMode(d, 'theme', 'Dark', 'Night')
    if (ambiguity === 'mode-reorder') d.designSystem!.collections.theme.modes.reverse()
    else setVariableCell(d, 'size', 'Night', 42.125)
  })
  expect(e.state.doc.designSystem!.collections.theme.modes).toEqual(['Light', 'Dark'])
  expect(e.state.doc.nodes[instance].instance!.overrides).toEqual({})
  expect(e.canUndo).toBe(false); expect(e.state.message).toContain('请分开操作')
  e.change('Rename separately', d => renameVariableMode(d, 'theme', 'Dark', 'Night'))
  expect(e.state.doc.designSystem!.collections.theme.modes).toEqual(['Light', 'Night'])
  if (ambiguity === 'value-edit') {
    e.change('Value separately', d => setVariableCell(d, 'size', 'Night', 42.125))
    expect(e.state.doc.designSystem!.variables.size.values.Night).toBe(42.125)
  }
  expect(e.state.doc.nodes[instance].instance!.overrides).toEqual({})
})
