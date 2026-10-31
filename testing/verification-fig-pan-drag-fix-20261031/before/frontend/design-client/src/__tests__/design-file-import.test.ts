import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { import_sketch_json } from '../generated/design-kernel/design_kernel'
import { importFig } from '../import-fig'
import { uid, validateDocument } from '../model'
// @ts-expect-error The policy is shared with dependency-free Node runner tests.
import { externalFixture } from '../../../../testing/lib/fixture-policy.mjs'

function checkDocument(value: unknown) {
  const doc = validateDocument(value)
  expect(doc.pages.length).toBeGreaterThan(0)
  expect(Object.keys(doc.nodes).length).toBeGreaterThan(0)
  return doc
}
function sketch(bytes: Uint8Array) {
  const report = JSON.parse(import_sketch_json(bytes))
  report.document.id = uid()
  return checkDocument(report.document)
}

test('public synthetic Sketch archive exercises the real WASM importer', () => {
  const bytes = zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 144, appVersion: '93' })),
    'document.json': strToU8(JSON.stringify({ _class: 'document', pages: [{ _ref: 'pages/10000000-0000-0000-0000-000000000001' }] })),
    'pages/10000000-0000-0000-0000-000000000001.json': strToU8(JSON.stringify({ _class: 'page', do_objectID: '10000000-0000-0000-0000-000000000001', name: 'Synthetic', layers: [{
      _class: 'rectangle', do_objectID: '10000000-0000-0000-0000-000000000002', name: 'Public rectangle',
      frame: { x: 10, y: 20, width: 42, height: 24 },
      style: { _class: 'style', fills: [{ _class: 'fill', isEnabled: true, fillType: 0,
        color: { _class: 'color', red: 1, green: 0, blue: 0, alpha: 1 } }] },
    }] })),
  })
  const doc = sketch(bytes)
  expect(Object.values(doc.nodes).find(n => n.name === 'Public rectangle')).toMatchObject({ width: 42, height: 24 })
  expect(() => sketch(bytes.subarray(0, 12))).toThrow()
})

test('committed FIG corpus exercises the real parser with a truncated-input negative control', () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig', import.meta.url)))
  checkDocument(importFig(bytes).document)
  expect(() => importFig(bytes.subarray(0, 12))).toThrow()
})

for (const [name, importer] of [
  ['DESIGN_TEST_SKETCH', sketch],
  ['DESIGN_TEST_FIG', (bytes: Uint8Array) => checkDocument(importFig(bytes).document)],
] as const) {
  test(`external corpus: ${name}`, context => {
    const fixture = externalFixture(name)
    if (fixture.skip) { context.skip(fixture.skip); return }
    importer(new Uint8Array(readFileSync(fixture.path)))
  })
}
