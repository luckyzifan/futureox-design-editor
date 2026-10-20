import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactResources } from '../src/artifacts.mjs'
import { getDesignPrompt, DESIGN_PROMPTS } from '../src/prompts.mjs'

test('resources retain actual HTML/CSS and document exports with exact bytes', () => {
  const resources = new ArtifactResources()
  const response = { ok: true, method: 'code.export', documentId: 'doc', revision: 3, result: { format: 'futureox.design-code.v1', html: '<main>设计</main>', css: 'main{color:red}', fidelity: 'approximate' } }
  const links = resources.capture(response)
  assert.equal(links.length, 2)
  assert.equal(links[0].type, 'resource_link')
  assert.equal(resources.read(links[0].uri).contents[0].text, response.result.html)
  assert.equal(resources.list()[1].mimeType, 'text/css')
  const doc = resources.capture({ ok: true, method: 'document.export', result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content: '{"a":1}' } })
  assert.equal(resources.read(doc[0].uri).contents[0].text, '{"a":1}')
  assert.equal(resources.read('file:///etc/passwd'), undefined)
})
test('artifact retention is bounded and does not cache failed/made-up outputs', () => {
  const resources = new ArtifactResources({ maxArtifacts: 1, maxBytes: 20, maxArtifactBytes: 15 })
  const make = html => ({ ok: true, result: { format: 'futureox.design-code.v1', html } })
  const first = resources.capture(make('first'))[0]
  const second = resources.capture(make('second'))[0]
  assert.equal(resources.read(first.uri), undefined)
  assert(resources.read(second.uri))
  assert.throws(() => resources.capture(make('x'.repeat(16))), { code: 'artifact_unavailable' })
  assert.deepEqual(resources.capture({ ok: false, result: make('no').result }), [])
  assert.deepEqual(resources.capture({ ok: true, result: { html: 'untyped' } }), [])
  assert.equal(resources.bytes, 6)
  resources.clear(); assert.equal(resources.bytes, 0); assert.equal(resources.list().length, 0)
})
test('workflow prompts are bounded, schema-aware client instructions', () => {
  assert.equal(DESIGN_PROMPTS.length, 2)
  const prompt = getDesignPrompt('design_generation', { brief: 'Build an invoice form' })
  assert.match(prompt.messages[0].content.text, /bounded, atomic schema-aware batch/)
  assert.match(prompt.messages[0].content.text, /Do not execute arbitrary JavaScript/)
  assert.match(getDesignPrompt('design_to_code').messages[0].content.text, /do not change the design unless/i)
  assert.throws(() => getDesignPrompt('design_generation'), /Missing/)
  assert.throws(() => getDesignPrompt('design_generation', { brief: 'x'.repeat(16001) }), /16000/)
  assert.throws(() => getDesignPrompt('design_to_code', { shell: 'rm' }), /declared/)
  assert.throws(() => getDesignPrompt('other'), /Unknown/)
})
test('native FD artifacts remain binary and SVG artifacts remain exact text', () => {
  const resources = new ArtifactResources()
  const base64 = Buffer.from([70, 68, 1, 2, 3, 4]).toString('base64')
  const fd = resources.capture({ ok: true, result: { format: 'futureox.design-document.v1', nativeFormat: 'fd', encoding: 'base64', mimeType: 'application/vnd.futureox-desgin', base64 } })[0]
  assert.equal(fd.name, 'design.fd'); assert.equal(fd.size, 6)
  assert.deepEqual(resources.read(fd.uri).contents[0], { uri: fd.uri, mimeType: fd.mimeType, blob: base64 })
  const svg = resources.capture({ ok: true, result: { format: 'futureox.design-vector.v1', mimeType: 'image/svg+xml', content: '<svg><path/></svg>' } })[0]
  assert.equal(resources.read(svg.uri).contents[0].text, '<svg><path/></svg>')
  assert.throws(() => resources.capture({ ok: true, result: { format: 'futureox.design-document.v1', nativeFormat: 'fd', encoding: 'base64', mimeType: fd.mimeType, base64: 'bad\nbytes' } }), { code: 'artifact_unavailable' })
})

test('large FD and native JSON are resource-only with exact bytes and honest eviction', () => {
  const resources = new ArtifactResources()
  const base64 = Buffer.alloc(23 * 1024 * 1024, 81).toString('base64')
  const fd = resources.project({ ok: true, method: 'document.export', revision: 3, result: { format: 'futureox.design-document.v1', nativeFormat: 'fd', encoding: 'base64', mimeType: 'application/vnd.futureox-desgin', bytes: 23 * 1024 * 1024, base64 } })
  assert.equal(fd.value.result.base64, undefined)
  assert.ok(JSON.stringify(fd).length < 4096)
  const ref = fd.value.result.resources[0]
  assert.equal(ref.field, 'base64'); assert.equal(resources.read(ref.uri).contents[0].blob, base64)
  const content = JSON.stringify({ fonts: { original: { data: 'B'.repeat(24 * 1024 * 1024) } } })
  const json = resources.project({ ok: true, method: 'document.export', result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content } })
  assert.equal(json.value.result.content, undefined)
  assert.equal(resources.read(json.value.result.resources[0].uri).contents[0].text, content)
  assert.equal(resources.read(ref.uri), undefined)
  resources.clear(); assert.equal(resources.read(json.value.result.resources[0].uri), undefined)
})

test('Sketch archives, code assets and large metadata retain exact explicit resources', () => {
  const resources = new ArtifactResources()
  const sketch = Buffer.from('PK\u0003\u0004real backend archive bytes').toString('base64')
  const archive = resources.project({ ok: true, result: { format: 'futureox.design-sketch.v1', encoding: 'base64', mimeType: 'application/zip', base64: sketch, fidelity: 'compatibility', lossless: false } })
  assert.equal(archive.value.result.base64, undefined); assert.equal(archive.links[0].name, 'design.sketch')
  assert.equal(resources.read(archive.value.result.resources[0].uri).contents[0].blob, sketch)
  const source = { format: 'futureox.design-code.v1', html: '<main>Actual</main>', css: 'main{color:red}', assets: [{ id: 'image', dataUrl: 'data:image/png;base64,AAAA' }], nodeIdMap: { node: { selector: 'x'.repeat(150000) } }, warnings: [{ code: 'actual', message: 'Keep fidelity warning' }] }
  const projected = resources.project({ ok: true, result: source })
  assert.equal(projected.value.result.html, undefined); assert.equal(projected.value.result.css, undefined)
  assert.equal(projected.value.result.assets, undefined); assert.equal(projected.value.result.nodeIdMap, undefined)
  assert.ok(JSON.stringify(projected).length < 8192)
  const restored = { ...projected.value.result }
  for (const ref of restored.resources) {
    const file = resources.read(ref.uri).contents[0]
    const value = ref.encoding === 'json' ? JSON.parse(file.text) : file.text
    if (ref.field === '$metadata') Object.assign(restored, value)
    else restored[ref.field] = value
  }
  for (const key of Object.keys(source)) assert.deepEqual(restored[key], source[key])
})

test('an uncacheable multi-artifact result fails atomically without evicting existing files', () => {
  const resources = new ArtifactResources({ maxArtifacts: 2, maxBytes: 20 })
  const first = resources.project({ ok: true, result: { format: 'futureox.design-code.v1', html: 'preserved' } }).links[0]
  assert.throws(() => resources.project({ ok: true, result: { format: 'futureox.design-code.v1', html: 'a'.repeat(15), css: 'b'.repeat(15) } }), { code: 'artifact_unavailable' })
  assert.equal(resources.read(first.uri).contents[0].text, 'preserved')
  assert.equal(resources.bytes, 9)
})

test('resource admission counts JSON escaping and the complete read-response envelope before linking', () => {
  const resources = new ArtifactResources({ maxResponseBytes: 4096 })
  const content = '\n'.repeat(1500)
  assert.equal(Buffer.byteLength(content), 1500)
  assert.throws(() => resources.project({ ok: true, result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content } }), { code: 'artifact_unavailable' })
  assert.equal(resources.list().length, 0)
  const accepted = resources.project({ ok: true, result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content: 'Q'.repeat(1700) } })
  const response = { jsonrpc: '2.0', id: '\0'.repeat(256), result: resources.read(accepted.links[0].uri) }
  assert.ok(Buffer.byteLength(JSON.stringify(response) + '\n') <= 4096)
})

test('SVGZ exports become exact binary resources with precision metadata preserved', () => {
  const resources = new ArtifactResources(), source = '<svg><title>矢量</title></svg>'
  const bytes = gzipSync(source), base64 = bytes.toString('base64')
  const response = { ok: true, method: 'vector.export', result: { format: 'futureox.design-vector.v1', mimeType: 'image/svg+xml', filename: 'design.svgz', encoding: 'base64', base64, options: { scale: 2, precision: 3, compression: 'gzip' }, precisionLossy: true } }
  const output = resources.project(response)
  assert.equal(output.links.length, 1)
  const link = output.links[0]
  assert.equal(link.name, 'design.svgz')
  const blob = resources.read(link.uri).contents[0].blob
  assert.equal(blob, base64); assert.equal(gunzipSync(Buffer.from(blob, 'base64')).toString(), source)
  assert.equal(output.value.result.base64, undefined)
  assert.equal(output.value.result.precisionLossy, true)
  assert.deepEqual(output.value.result.options, response.result.options)
})
