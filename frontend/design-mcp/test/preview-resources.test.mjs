import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactResources, previewImage } from '../src/artifacts.mjs'
import { DesignMcpServer } from '../src/server.mjs'
const preview = (size = 32) => ({ ok: true, method: 'preview.capture', documentId: 'doc', session: 2, revision: 3, result: {
  format: 'futureox.design-preview.v1', mimeType: 'image/png', width: 4, height: 4, bounds: { x: 5, y: 6, width: 4, height: 4 }, pageId: 'page', nodeIds: ['node'], bytes: size,
  backend: 'cpu', renderer: 'product-cpu-export', screenshot: false, dataUrl: `data:image/png;base64,${Buffer.alloc(size, 81).toString('base64')}`,
} })
// Binary fixtures test transport only. They deliberately are not claimed as renderer pixels.
test('even tiny previews have exact immutable resources, with no duplicated inline base64', () => {
  const resources = new ArtifactResources(), original = preview()
  const projected = resources.project(original)
  assert.equal(projected.value.result.dataUrl, undefined)
  assert.equal(projected.links.length, 1)
  assert.deepEqual(projected.value.result.bounds, original.result.bounds)
  assert.equal(projected.value.revision, 3)
  assert.equal(resources.read(projected.links[0].uri).contents[0].blob, original.result.dataUrl.split(',')[1])
  original.result.dataUrl = 'changed'
  assert.equal(resources.read(projected.links[0].uri).contents[0].blob, Buffer.alloc(32, 81).toString('base64'))
  assert.match(projected.links[0].description, /Immutable export snapshot/)
  resources.clear(); assert.equal(resources.read(projected.links[0].uri), undefined)
})
test('image content accounts for its exact encoded JSON budget', () => {
  const source = preview(), image = previewImage(source), bytes = Buffer.byteLength(JSON.stringify(image))
  assert.deepEqual(previewImage(source, bytes), image)
  assert.equal(previewImage(source, bytes - 1), undefined)
  for (const dataUrl of ['not-a-data-url', 'data:image/png;base64,!', 'data:image/png;base64,']) {
    source.result.dataUrl = dataUrl
    assert.equal(previewImage(source), undefined)
    assert.throws(() => new ArtifactResources().project(source), { code: 'artifact_unavailable' })
  }
})
test('MCP includes image content once when bounded, otherwise preserves a usable image resource', async () => {
  const descriptor = { name: 'design_preview_capture', description: 'Preview', inputSchema: { type: 'object' } }
  let source = preview(1024)
  const server = new DesignMcpServer({ backend: { listTools: () => [descriptor], callTool: () => source } })
  const context = { signal: new AbortController().signal, requestId: 1 }
  const small = await server.callTool({ name: descriptor.name }, context)
  assert.equal(small.isError, false)
  assert.equal(small.content.filter(item => item.type === 'image').length, 1)
  assert.equal(small.content.filter(item => item.type === 'resource_link').length, 1)
  assert.equal(small.structuredContent.result.dataUrl, undefined)
  assert.equal(JSON.parse(small.content[0].text).result.dataUrl, undefined)
  assert.equal(JSON.stringify(small).split(source.result.dataUrl.split(',')[1]).length - 1, 1)
  source = preview(220 * 1024)
  const large = await server.callTool({ name: descriptor.name }, context)
  assert.equal(large.isError, false)
  assert.equal(large.content.some(item => item.type === 'image'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024)
  assert.equal(server.artifacts.read(large.structuredContent.result.resources[0].uri).contents[0].blob, source.result.dataUrl.split(',')[1])
})
test('app export projects a complete inert runnable bundle and asset manifest atomically', () => {
  const result = { format: 'futureox.design-app.v1', html: '<main>App</main>', css: 'main{color:red}', javascript: 'throw new Error("never executed by transport")', appJson: '{"routes":[]}', readme: '# Usage', assets: [{ id: 'photo', dataUrl: 'data:image/png;base64,AAAA' }] }
  const resources = new ArtifactResources(), projected = resources.project({ ok: true, method: 'app.export', revision: 7, result })
  assert.deepEqual(projected.links.map(link => link.name), ['index.html', 'styles.css', 'app.js', 'app.json', 'README.md', 'assets.json'])
  for (const ref of projected.value.result.resources) {
    assert.equal(projected.value.result[ref.field], undefined)
    const text = resources.read(ref.uri).contents[0].text
    assert.deepEqual(ref.encoding === 'json' ? JSON.parse(text) : text, result[ref.field])
  }
  assert.throws(() => new ArtifactResources({ maxArtifacts: 5 }).project({ ok: true, result }), { code: 'artifact_unavailable' })
})

test('generation guidance requires viewing actual image content and discloses blocked visual inspection', async () => {
  const { getDesignPrompt } = await import('../src/prompts.mjs')
  const text = getDesignPrompt('design_generation', { brief: 'Refine the selected card' }).messages[0].content.text
  assert.match(text, /actually inspect the returned MCP image content/)
  assert.match(text, /client cannot display it/)
  assert.match(text, /never silently resize/)
  assert.match(text, /immutable snapshots/)
})
