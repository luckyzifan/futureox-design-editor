import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { blank, node, validateDocument } from './model.ts'
import { localSave } from './local-store.ts'

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

test('opening validates the incoming document before local publication or editing-session adoption', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
  const picking = read('./kernel/picking.ts')
  const preparation = picking.slice(picking.indexOf('export function prepareDocumentForEditing'), picking.indexOf('export function kernelLayout'))
  assert.match(preparation, /const original = admitDocumentSync\(value\)/)
  assert.ok(preparation.indexOf('admitDocumentSync(value)') < preparation.indexOf('const prepared = kernelLayout('))
  assert.match(preparation, /validateKernelDocument\(JSON\.stringify\(prepared\)\)/)
  assert.ok(preparation.indexOf('validateKernelDocument(JSON.stringify(prepared))') < preparation.indexOf('return prepared'))
  const app = read('./App.tsx')
  const opening = app.slice(app.indexOf('async function switchDocument('), app.indexOf('async function openLocalFiles('))
  assert.ok(opening.indexOf('document = prepareDocumentForEditing(document)') >= 0)
  assert.ok(opening.indexOf('document = prepareDocumentForEditing(document)') < opening.indexOf('await localSave(document,'))
  const engine = read('./engine.ts')
  const adoption = engine.slice(engine.indexOf('  load(value: unknown)'), engine.indexOf('  load(value: unknown)') + 800)
  assert.match(adoption, /const doc = prepareDocumentForEditing\(value\)/)
  assert.ok(adoption.indexOf('prepareDocumentForEditing(value)') < adoption.indexOf('this.sessionEpoch++'))
  assert.ok(adoption.indexOf('prepareDocumentForEditing(value)') < adoption.indexOf('this.set({'))
})
