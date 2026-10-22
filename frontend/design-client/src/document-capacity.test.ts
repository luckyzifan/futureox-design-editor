import { expect, test } from 'vitest'
import { assertDocumentBytes, assertDocumentStructure, capacityFromMemory, documentCapacity, utf8Bytes } from './document-capacity'
import { admitDocumentJsonSync } from './document-admission'
import { blank, node, validateDocument } from './model'
import { Editor } from './engine'
import { createEditorDesignAutomation } from './automation'
import { forma_encode_json, forma_decode_json, document_capacity_bytes } from './generated/design-kernel/design_kernel'

test('resource allowance scales with trusted memory, has an exact boundary and reports the effective limit', () => {
  const small = capacityFromMemory(64 * 1024 * 1024), large = capacityFromMemory(2 * 1024 ** 3)
  expect(large.documentBytes / small.documentBytes).toBe(32)
  expect(() => assertDocumentBytes(small.documentBytes, small)).not.toThrow()
  expect(() => assertDocumentBytes(small.documentBytes + 1, small)).toThrow(`${small.documentBytes}-byte document allowance`)
  for (const value of [NaN, Infinity, -1, 1.5, 2 ** 32 + 1]) expect(() => capacityFromMemory(value)).toThrow()
})

test('UTF-8 accounting matches the platform encoder without retaining another document buffer', () => {
  for (const value of ['', 'hello', '中文😀', '\ud800', '\udc00', '\ud800x\udc00', '\u0000\n"\\'])
    expect(utf8Bytes(value)).toBe(new TextEncoder().encode(value).byteLength)
})

test('main TS and actual WASM share the exact pinned resource allowance', () => {
  expect(document_capacity_bytes()).toBe(documentCapacity().documentBytes)
})

test('an actual document beyond the legacy 32 MiB boundary admits and roundtrips FD without dropping bytes', () => {
  const text = '界'.repeat(Math.ceil(33 * 1024 * 1024 / 3))
  const document = { ...blank(), portableUnknownPayload: text }
  const source = JSON.stringify(document)
  expect(utf8Bytes(source)).toBeGreaterThan(32 * 1024 * 1024)
  // Fail rather than skip if this machine does not have enough admitted memory.
  expect(utf8Bytes(source)).toBeLessThan(documentCapacity().documentBytes)
  expect(admitDocumentJsonSync(source)).toEqual(document)
  const encoded = forma_encode_json(source)
  expect(JSON.parse(forma_decode_json(encoded))).toEqual(document)
  const imported = blank(), shape = node('rectangle', 0, 0, 10, 10)
  imported.nodes[shape.id] = shape; imported.pages[0].children.push(shape.id)
  const editor = new Editor(document), api = createEditorDesignAutomation(editor)
  try {
    const before = editor.state.doc
    const response = api.execute({ method: 'document.import', params: { format: 'native-json', document: imported, pageId: editor.state.page },
      documentId: before.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
    expect(response.ok, JSON.stringify(response)).toBe(true)
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(2)
    expect((editor.state.doc as typeof document).portableUnknownPayload).toBe(text)
    expect(before.nodes).toEqual({})
    editor.undo(); expect(editor.state.doc).toBe(before)
    editor.redo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(2)
  } finally { api.dispose(); editor.dispose() }
}, 60_000)

test('aggregate pages and nodes are resource bounded, not legacy 100-page/20k-node business quotas', () => {
  const document = blank()
  document.pages = Array.from({ length: 101 }, (_, i) => ({ ...document.pages[0], id: crypto.randomUUID(), children: [] }))
  for (let i = 0; i < 20_001; i++) {
    const shape = node('rectangle', 0, 0, 1, 1)
    document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  }
  expect(validateDocument(document)).toBe(document)
  expect(admitDocumentJsonSync(JSON.stringify(document)).pages).toHaveLength(101)
  const editor = new Editor(document), api = createEditorDesignAutomation(editor)
  try {
    const request = (index: number) => api.execute({ method: 'node.create', params: { kind: 'rectangle', index },
      documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
    expect(request(20_001).ok).toBe(true)
    expect(editor.state.doc.pages[0].children).toHaveLength(20_002)
    const before = editor.state.doc, version = editor.state.version
    expect(request(20_003)).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
    editor.undo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(20_001)
    editor.redo(); expect(editor.state.doc).toBe(before)
  } finally { api.dispose(); editor.dispose() }
  const capacity = documentCapacity()
  expect(() => assertDocumentStructure(capacity.nodeCount, capacity.pageCount)).not.toThrow()
  expect(() => assertDocumentStructure(capacity.nodeCount + 1, 1)).toThrow('DOCUMENT_RESOURCE_LIMIT')
  expect(() => assertDocumentStructure(0, capacity.pageCount + 1)).toThrow('DOCUMENT_RESOURCE_LIMIT')
  for (const count of [NaN, -1, 1.5]) expect(() => assertDocumentStructure(count, 1)).toThrow()
}, 60_000)
