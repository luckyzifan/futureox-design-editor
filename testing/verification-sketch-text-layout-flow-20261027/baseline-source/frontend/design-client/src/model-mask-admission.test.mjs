import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { blank, node, validateDocument } from './model.ts'
import { localSave } from './local-store.ts'
import { prepareDocumentForEditing, prepareDocumentJsonForEditing } from './kernel/picking.ts'
import { prepareDocument, prepareDocumentJson } from './prepared-document.ts'

function fixture(schemaVersion, maskType) {
  const document = blank(), shape = node('rectangle')
  document.schemaVersion = schemaVersion
  if (maskType !== undefined) shape.maskType = maskType
  document.nodes[shape.id] = shape
  document.pages[0].children = [shape.id]
  return document
}

test('omitted and null mask mode remain legacy-compatible in schema 1 through 6', () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    for (const maskType of [undefined, null]) {
      const document = fixture(version, maskType)
      assert.equal(validateDocument(document), document)
    }
  }
})

test('explicit alpha and luminance require schema 4 even when mask is not active', () => {
  for (const maskType of ['alpha', 'luminance']) {
    for (const version of [1, 2, 3]) {
      const document = fixture(version, maskType), before = JSON.stringify(document)
      assert.throws(() => validateDocument(document), /设计文件版本 4/)
      assert.equal(JSON.stringify(document), before)
    }
    for (const version of [4, 5, 6]) {
      const document = fixture(version, maskType)
      assert.equal(validateDocument(document), document)
    }
  }
})

test('unknown and non-string mask values cannot be adopted as a default mode', () => {
  for (const invalid of ['', 'invalid', 'Alpha', false, 0, [], {}]) {
    assert.throws(() => validateDocument(fixture(4, invalid)), /蒙版类型无效/)
  }
})

test('local save rejects invalid mask contracts before opening IndexedDB', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  let opens = 0
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true, value: { open() { opens++; throw new Error('Persistence must not begin') } },
  })
  try {
    await assert.rejects(localSave(fixture(3, 'luminance')), /设计文件版本 4/)
    await assert.rejects(localSave(fixture(4, 'invalid')), /蒙版类型无效/)
    assert.equal(opens, 0)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous)
    else delete globalThis.indexedDB
  }
})

test('source contract: opening prepares before local publication and adoption accepts only owned preparation', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
  const picking = read('./kernel/picking.ts')
  const preparation = picking.slice(picking.indexOf('export function prepareDocumentForEditing'), picking.indexOf('export function kernelLayout'))
  assert.match(preparation, /return prepareAdmittedDocument\(documentStage\(DocumentStage\.admission, \(\) => admitDocumentSync\(value\)\), captureValidatedJson\)/)
  assert.match(preparation, /return prepareAdmittedDocument\(admitDocumentJsonSync\(source, syntaxFailureAttempt\), captureValidatedJson\)/)
  assert.match(preparation, /function prepareAdmittedDocument\(original: DesignDocument, captureValidatedJson\?: \(json: string\) => void\): DesignDocument \{\s+const prepared = documentStage\(DocumentStage\.layout, \(\) => kernelLayout\(\{/)
  assert.ok(preparation.indexOf('admitDocumentSync(value)') < preparation.indexOf('const prepared = documentStage(DocumentStage.layout'))
  assert.match(preparation, /const json = JSON\.stringify\(prepared\)\s+validateKernelDocument\(json\)\s+captureValidatedJson\?\.\(json\)/)
  assert.ok(preparation.indexOf('validateKernelDocument(json)') < preparation.indexOf('return prepared'))
  const app = read('./App.tsx')
  const opening = app.slice(app.indexOf('async function switchDocument('), app.indexOf('async function openLocalFiles('))
  const preparedAt = opening.indexOf('const prepared = prepareDocument(document)')
  assert.ok(preparedAt >= 0, 'opening must prepare before persistence')
  assert.ok(preparedAt < opening.indexOf('document = prepared.snapshot()'))
  assert.ok(preparedAt < opening.indexOf('await localSave(document,'))
  assert.match(opening, /editor\.load\(prepared\)/)
  const preparationToken = read('./prepared-document.ts')
  assert.match(preparationToken, /const document = prepareDocumentForEditing\(value, json => \{ validatedJson = json \}\)/)
  assert.match(preparationToken, /const record = owned\.get\(value\)/)
  const engine = read('./engine.ts')
  assert.match(engine, /const prepared = ensurePreparedDocument\(value\), encoding = preparedDocumentEncoding\(prepared\)/)
  assert.match(engine, /const doc = takePreparedDocument\(prepared\)!/)
  // Behavioral aliasing, invalid-input and token-reuse checks run in
  // prepared-document.test.ts against the actual WASM and Editor.
})

test('object and JSON preparation reject hidden unsupported masks without publishing validated bytes or ownership', () => {
  const cases = []
  for (const version of [1, 2, 3])
    for (const maskType of ['alpha', 'luminance'])
      cases.push([version, maskType, '显式蒙版类型需要设计文件版本 4'])
  for (const version of [4, 15])
    for (const maskType of ['', 'invalid', 'Alpha', false, 0, [], {}])
      cases.push([version, maskType, '蒙版类型无效'])

  for (const [version, maskType, message] of cases) {
    const document = fixture(version, maskType)
    const shape = document.nodes[document.pages[0].children[0]]
    shape.visible = false
    shape.mask = false
    const before = structuredClone(document), source = JSON.stringify(document)
    let captured = 0
    const capture = () => { captured++ }
    for (const prepare of [
      () => prepareDocumentForEditing(document, capture),
      () => prepareDocumentJsonForEditing(source, capture),
      () => prepareDocument(document),
      () => prepareDocumentJson(source),
    ]) {
      // An uninitialized-layout error must not satisfy this rejection test.
      assert.throws(prepare, { name: 'Error', message })
      assert.equal(captured, 0)
      assert.deepEqual(document, before)
    }
  }
})
