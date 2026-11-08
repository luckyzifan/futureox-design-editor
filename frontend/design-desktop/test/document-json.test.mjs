import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedDocumentJson } from '../src/document-json.mjs'

const document = { schemaVersion: 2, name: 'topology', pages: [], nodes: {} }

test('workspace publication accepts a string, an object, or utf-8 bytes', () => {
  const json = JSON.stringify(document)
  assert.equal(publishedDocumentJson({ documentJson: json }), json)
  assert.equal(publishedDocumentJson({ document }), json)
  assert.equal(publishedDocumentJson({ documentJson: document }), json)
  assert.equal(publishedDocumentJson({ document: Buffer.from(json) }), json)
  assert.equal(publishedDocumentJson({ documentJson: Buffer.from('\ufeff' + json) }), json)
  assert.equal(publishedDocumentJson({}), undefined)
  assert.equal(publishedDocumentJson({ documentJson: '' }), undefined)
})
