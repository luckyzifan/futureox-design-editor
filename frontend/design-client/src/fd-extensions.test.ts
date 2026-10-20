import { describe, expect, it } from 'vitest'
import { blank, node, validateDocument } from './model'
import { validateFdCompatibility, type FdCompatibility } from './fd-extensions'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { prepareDocumentForEditing } from './kernel/picking'
import { admitDocumentSync } from './document-admission'
import { validateKernelDocument } from './kernel/module'
import { appendDocument } from './append-document'
import { Editor } from './engine'
import { exportNativeDocument } from './automation/export'
const envelope = (payload: unknown = { arbitrary: [null, true, 1.25, '文字'], url: 'file:///inert', permission: 'not authority' }): FdCompatibility => ({ contractVersion: 1, requiredCapabilities: [], extensions: { 'org.example/metadata': payload } })
describe('FD inert extension contract', () => {
  it('retains unknown optional payload through native JSON, FD, admission, layout and edit history', () => {
    const source = blank('FD extensions'), shape = node('rectangle', 0, 0, 10, 10)
    source.nodes[shape.id] = shape; source.pages[0].children.push(shape.id)
    source.fdCompatibility = envelope()
    expect(validateDocument(source)).toBe(source)
    expect(JSON.parse(exportNativeDocument(source).content).fdCompatibility).toEqual(source.fdCompatibility)
    const restored = decodeDocumentBinary(encodeDocumentBinary(source))
    expect(restored).toEqual(source)
    const prepared = prepareDocumentForEditing(admitDocumentSync(restored))
    expect(prepared.fdCompatibility).toEqual(source.fdCompatibility)
    const editor = new Editor(prepared)
    editor.change('rename', draft => { draft.name = 'Edited' })
    expect(editor.state.doc.fdCompatibility).toEqual(source.fdCompatibility)
    editor.undo(); expect(editor.state.doc.fdCompatibility).toEqual(source.fdCompatibility)
    editor.redo(); expect(editor.state.doc.fdCompatibility).toEqual(source.fdCompatibility)
    const nextMetadata = envelope({ changed: true })
    editor.change('metadata', draft => { draft.fdCompatibility = nextMetadata })
    expect(editor.state.doc.fdCompatibility).toEqual(nextMetadata)
    editor.undo(); expect(editor.state.doc.fdCompatibility).toEqual(source.fdCompatibility)
    editor.redo(); expect(editor.state.doc.fdCompatibility).toEqual(nextMetadata)
  })
  it('rejects required semantics before adoption and append mutation', () => {
    const source = blank(), target = blank(); source.fdCompatibility = envelope()
    const before = JSON.stringify(target)
    expect(() => appendDocument(target, source, target.pages[0].id)).toThrow('reference remapper')
    expect(JSON.stringify(target)).toBe(before)
    source.fdCompatibility.requiredCapabilities = ['org.example/render']
    expect(() => validateKernelDocument(JSON.stringify(source))).toThrow('unsupported required capability')
    expect(() => encodeDocumentBinary(source)).toThrow('unsupported required capability')
    expect(() => admitDocumentSync(source)).toThrow('unsupported required capability')
    expect(() => prepareDocumentForEditing(source)).toThrow('unsupported required capability')
  })
  it('uses a portable exact resource-cost boundary independent of number formatting', () => {
    const length = 1024 * 1024 - 128 - 64 - 'org.example/metadata'.length
    expect(() => validateFdCompatibility(envelope('x'.repeat(length)))).not.toThrow()
    expect(() => validateFdCompatibility(envelope('x'.repeat(length + 1)))).toThrow('byte budget')
    expect(() => validateFdCompatibility(envelope([1, 1.0, 1e-7, 1e21, '🌈']))).not.toThrow()
  })
  it('rejects malformed versions, namespaces, unsafe data and resource bombs', () => {
    for (const bad of [ { ...envelope(), contractVersion: 2 }, { ...envelope(), extra: true }, { ...envelope(), extensions: { plain: {} } }, envelope(JSON.parse('{"__proto__":{}}')), envelope({ x: undefined }), envelope(Infinity), envelope('\ud800'), envelope('x'.repeat(1024 * 1024)), envelope(Array(100_000).fill(0)), envelope(Array(1_000_000_000)), envelope(Array(2)) ]) {
      expect(() => validateFdCompatibility(bad)).toThrow()
    }
    let deep: unknown = null; for (let i = 0; i < 32; i++) deep = [deep]
    expect(() => validateFdCompatibility(envelope(deep))).toThrow('structural budget')
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => validateFdCompatibility(envelope(cycle))).toThrow('cyclic')
    expect(() => validateFdCompatibility({ ...envelope(), extensions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`org.example/item${i}`, null])) })).toThrow()
  })
})
