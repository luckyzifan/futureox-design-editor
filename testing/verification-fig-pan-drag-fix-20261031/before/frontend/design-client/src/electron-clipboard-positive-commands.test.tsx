// Import into client/src before running. Real Editor/WASM, only OS clipboard is controlled.
import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, stroke, effect } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { readProperties } from './property-clipboard'
import { emptySystem } from './design-system'
import { worldMatrix } from './geometry'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); vi.unstubAllGlobals() })
function fixture(name = 'source') {
  const d = blank(name), a = node('rectangle', 10, 20, 30, 40), b = node('rectangle', 150, 180, 70, 80)
  a.name = 'Authored source'; b.name = 'Keep destination'; a.fills = [paint('#13579b')]
  a.strokes = [{ ...stroke(), width: 3 }]; a.effects = [{ ...effect('shadow'), radius: 4 }]
  d.nodes = { [a.id]: a, [b.id]: b }; d.pages[0].children = [a.id, b.id]
  const e = new Editor(d); editors.push(e); e.select([a.id]); return { e, a, b }
}
function clipboard() {
  let value: any
  const write = vi.fn(async (next: any) => { value = next; return { status: 'ok' } })
  const read = vi.fn(async () => ({ status: 'ok', ...value }))
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write, read } } })
  return { write, read, get value() { return value } }
}
it.each([['copy-properties', 'all'], ['copy-fills', 'fills'], ['copy-strokes', 'strokes'], ['copy-effects', 'effects']] as const)('%s emits actual bounded property payload and paste-properties commits only intended fields', async (command, kind) => {
  const f = fixture(), c = clipboard(), before = f.e.state.doc, version = f.e.state.version
  await dispatchEditorCommand(f.e, command)
  expect(c.write).toHaveBeenCalledTimes(1)
  const packet = readProperties(c.value.text)
  expect(packet.kind).toBe(kind); expect(Object.keys(packet.document.nodes)).toHaveLength(1)
  expect(c.value.text).not.toContain(f.a.name); expect(c.value.text).not.toContain(f.b.id)
  expect(f.e.state.doc).toBe(before); expect(f.e.state.version).toBe(version); expect(f.e.canUndo).toBe(false)
  f.e.select([f.b.id]); await dispatchEditorCommand(f.e, 'paste-properties')
  const after = f.e.state.doc, target = after.nodes[f.b.id], original = before.nodes[f.b.id]
  expect(target.name).toBe(original.name); expect(target.transform).toEqual(original.transform)
  expect([target.width, target.height]).toEqual([original.width, original.height])
  for (const key of ['fills', 'strokes', 'effects'] as const) expect(target[key]).toEqual(kind === 'all' || kind === key ? before.nodes[f.a.id][key] : original[key])
  expect(f.e.state.version).toBe(version + 1); f.e.undo(); expect(f.e.state.doc).toEqual(before)
  expect(f.e.canUndo).toBe(false); f.e.redo(); expect(f.e.state.doc).toEqual(after)
})
it('copy-fills and paste-properties carry reachable authored variable resources across collisions', async () => {
  const f = fixture(), d = structuredClone(f.e.state.doc); d.schemaVersion = 6; d.designSystem = emptySystem()
  d.designSystem.collections.colors = { name: 'Colors', modes: ['Light'], defaultMode: 'Light' }
  d.designSystem.activeModes.colors = 'Light'; d.designSystem.variables.brand = { name: 'Brand', kind: 'color', collection: 'colors', values: { Light: '#ff0000' } }
  d.nodes[f.a.id].bindings = { 'fills.0.color': 'brand' }; f.e.load(d); f.e.select([f.a.id])
  const c = clipboard(); await dispatchEditorCommand(f.e, 'copy-fills')
  const packet = readProperties(c.value.text); expect(Object.values(packet.document.designSystem!.variables).some(v => v.name === 'Brand')).toBe(true)
  const target = structuredClone(d); target.designSystem!.variables.brand.values.Light = '#00ff00'
  f.e.load(target); f.e.select([f.b.id]); const before = f.e.state.doc
  await dispatchEditorCommand(f.e, 'paste-properties')
  const after = f.e.state.doc, ref = after.nodes[f.b.id].bindings!['fills.0.color']
  expect(ref).not.toBe('brand'); expect(after.designSystem!.variables.brand.values.Light).toBe('#00ff00')
  expect(after.designSystem!.variables[ref].values.Light).toBe('#ff0000'); expect(after.nodes[f.b.id].fills[0].color).toBe('#ff0000')
  f.e.undo(); expect(f.e.state.doc).toEqual(before); f.e.redo(); expect(f.e.state.doc).toEqual(after)
})
it('successful cut writes the original graph before removal and uses one undo entry', async () => {
  const f = fixture(), before = f.e.state.doc, c = clipboard()
  await dispatchEditorCommand(f.e, 'cut')
  expect(c.write).toHaveBeenCalledTimes(1)
  const packet = JSON.parse(c.value.forma)
  expect(packet.document.nodes[f.a.id].fills).toEqual(before.nodes[f.a.id].fills)
  expect(packet.document.nodes[f.a.id].name).toBe('Authored source'); expect(packet.document.nodes[f.b.id]).toBeUndefined()
  expect(f.e.state.doc.nodes[f.a.id]).toBeUndefined(); expect(f.e.state.doc.nodes[f.b.id]).toEqual(before.nodes[f.b.id])
  const after = f.e.state.doc; f.e.undo(); expect(f.e.state.doc).toEqual(before); expect(f.e.canUndo).toBe(false)
  f.e.redo(); expect(f.e.state.doc).toEqual(after)
})
it.each(['paste-here', 'paste-to-replace'] as const)('%s reads copied graph and commits geometry/resources with one undo', async command => {
  const f = fixture(), c = clipboard(); await dispatchEditorCommand(f.e, 'copy')
  const target = fixture('target'); target.e.select([target.b.id]); const before = target.e.state.doc
  await dispatchEditorCommand(target.e, command, command === 'paste-here' ? { worldPoint: { x: 400, y: 500 } } : {})
  expect(c.read).toHaveBeenCalledTimes(1)
  const id = target.e.state.selection[0], pasted = target.e.state.doc.nodes[id]
  expect(id).not.toBe(f.a.id); expect(id).not.toBe(target.b.id)
  expect(pasted.name).toBe('Authored source'); expect(pasted.fills).toEqual(f.e.state.doc.nodes[f.a.id].fills)
  expect(pasted.strokes).toEqual(f.e.state.doc.nodes[f.a.id].strokes); expect(pasted.effects).toEqual(f.e.state.doc.nodes[f.a.id].effects)
  expect(worldMatrix(target.e.state.doc, id).slice(4)).toEqual(command === 'paste-here' ? [400, 500] : [150, 180])
  if (command === 'paste-to-replace') expect(target.e.state.doc.nodes[target.b.id]).toBeUndefined()
  else expect(target.e.state.doc.nodes[target.b.id]).toEqual(before.nodes[target.b.id])
  const after = target.e.state.doc; target.e.undo(); expect(target.e.state.doc).toEqual(before); expect(target.e.canUndo).toBe(false)
  target.e.redo(); expect(target.e.state.doc).toEqual(after)
})
