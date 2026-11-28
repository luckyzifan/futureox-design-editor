import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'
import { FIGMA_MCP_GAPS, FIGMA_MCP_INSTRUCTIONS, FIGMA_MCP_TOOLS, FigmaFacade, metadataXml, registerFigmaPluginBridge, validateFigmaOperation } from '../src/figma-facade.mjs'
import { FIGMA_COMPATIBILITY_TOOLS } from '../src/figma-weave-tools.mjs'

const METHODS = ['document.get', 'page.list', 'node.find', 'node.get', 'selection.get', 'context.get', 'code.export', 'preview.capture', 'variable.list', 'style.list', 'vector.export', 'raster.sourceAssets', 'batch.apply', 'workspace.open']

function facade(handlers, { scope = 'write', pluginBridge, methods = METHODS } = {}) {
  const calls = []
  const execute = async request => {
    calls.push(request)
    const handler = handlers[request.method]
    if (!handler) return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: 4, error: { code: 'missing', message: request.method } }
    const result = await handler(request)
    return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: result?.revision ?? 4, result }
  }
  return {
    calls,
    api: new FigmaFacade({
      execute, scope, pluginBridge,
      methods: methods.map(name => ({ name, description: name, inputSchema: { type: 'object' }, mutates: name === 'batch.apply' || name === 'workspace.open' })),
      target: { documentId: 'doc-1', session: 3 },
    }),
  }
}

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response }

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}

/** Real 8-bit RGBA PNG bytes, small enough for an exact pixel assertion. */
function makePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row++) {
    raw[row * stride] = 0
    rgba.copy(raw, row * stride + 1, row * width * 4, (row + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function decodePng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let offset = 8, width, height
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      assert.equal(data[9], 6)
    }
    if (type === 'IDAT') idat.push(data)
    offset += length + 12
    if (type === 'IEND') break
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4 + 1
  assert.equal(raw.length, stride * height)
  const pixels = []
  for (let row = 0; row < height; row++) {
    assert.equal(raw[row * stride], 0)
    for (let byte = 0; byte < width * 4; byte++) pixels.push(raw[row * stride + 1 + byte])
  }
  return { width, height, pixels }
}

test('advertised tools match the Figma-shaped subset and do not invent registry aliases', () => {
  assert.deepEqual(FIGMA_MCP_TOOLS.map(tool => tool.name), ['get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets', 'use_figma', 'open_document'])
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'whoami' && gap.status === 'absent'))
  assert.ok(FIGMA_MCP_GAPS.some(gap => gap.id === 'use_figma_plugin_javascript'))
  assert.equal(validateFigmaOperation({ op: 'create', kind: 'button' }), 'create kind must be one of slice, frame, section, group, rectangle, ellipse, polygon, star, line, vector, text')
})

test('metadata XML escapes names and nests by parent', () => {
  const xml = metadataXml('Doc', [
    { id: 'parent', name: 'A&B', kind: 'frame', width: 100, height: 40, worldBounds: { x: 1, y: 2 } },
    { id: 'child', name: 'Title', kind: 'text', parentId: 'parent', width: 10, height: 8 },
  ])
  assert.equal(xml, '<canvas name="Doc"><frame id="parent" name="A&amp;B" x="1" y="2" width="100" height="40"><text id="child" name="Title" width="10" height="8" /></frame></canvas>')
})

test('get_metadata lists pages, then a subtree, and ignores fileKey', async () => {
  const { api, calls } = facade({
    'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }),
    'node.find': request => ({ nodes: [{ id: request.params.rootId, name: 'Card', kind: 'frame', width: 20, height: 10 }], total: 1, nextCursor: null }),
  })
  const pages = ok(await api.callTool('get_metadata', { fileKey: 'figma-file' }, {}))
  assert.match(pages.result.modelText, /<page id="page-1" name="Cover"/)
  assert.equal(pages.result.fileKeyIgnored, true)
  const subtree = ok(await api.callTool('get_metadata', { nodeId: 'node-1' }, {}))
  assert.equal(calls.at(-1).params.rootId, 'node-1')
  assert.match(subtree.result.xml, /id="node-1"/)
  const cursor = await api.callTool('get_metadata', { cursor: 'next' }, {})
  assert.equal(cursor.error.code, 'invalid_params')
})

test('get_metadata accepts Figma node ids and returns the page list when the id is not local', async () => {
  const calls = []
  const api = new FigmaFacade({
    methods: ['page.list', 'node.find'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
    target: { documentId: 'doc-1', session: 3 },
    execute: async request => {
      calls.push(request)
      if (request.method === 'page.list') return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: 4, result: { pages: [{ id: 'page-1', name: 'Cover' }] } }
      return { ok: false, method: request.method, documentId: 'doc-1', session: 3, revision: 4, error: { code: 'not_found', message: 'Node does not exist' } }
    },
  })
  const urlForm = ok(await api.callTool('get_metadata', { nodeId: '1-23', fileKey: 'abcdefghijklmnopqrstuv', limit: 25 }, {})).result
  assert.equal(urlForm.scope, 'pages')
  assert.equal(urlForm.requestedNodeId, '1-23')
  assert.equal(urlForm.nodeId, '1:23')
  assert.equal(urlForm.normalizedFrom, '1-23')
  assert.equal(urlForm.unresolvedNodeId, '1:23')
  assert.equal(urlForm.figmaStyleNodeId, true)
  assert.match(urlForm.modelText, /<page id="page-1" name="Cover"/)
  assert.deepEqual(calls.map(call => call.method), ['page.list', 'node.find'])
  assert.deepEqual(calls.at(-1).params, { rootId: '1:23', limit: 25 })
  const unknownLocal = await api.callTool('get_metadata', { nodeId: 'missing-local-id' }, {})
  assert.equal(unknownLocal.error.code, 'not_found')
  assert.deepEqual(unknownLocal.error.details.pages, [{ id: 'page-1', name: 'Cover' }])
})

test('get_metadata continues the native query with the same nodeId and fresh read fences', async () => {
  const { api, calls } = facade({
    'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }),
    'node.find': ({ params }) => ({
      nodes: [{ id: params.cursor ? 'second' : 'first', kind: 'rectangle' }],
      total: 2,
      nextCursor: params.cursor ? null : '4:1',
    }),
  })
  const first = ok(await api.callTool('get_metadata', { nodeId: 'page-1', limit: 1 })).result
  assert.deepEqual(first.nodes.map(node => node.id), ['first'])
  assert.equal(first.truncated, true)
  assert.equal(typeof first.nextCursor, 'string')
  const second = ok(await api.callTool('get_metadata', { nodeId: 'page-1', limit: 1, cursor: first.nextCursor })).result
  assert.deepEqual(second.nodes.map(node => node.id), ['second'])
  assert.equal(second.nextCursor, null)
  assert.equal(second.truncated, false)
  assert.deepEqual(calls.at(-1), { method: 'node.find', params: { pageId: 'page-1', limit: 1, cursor: '4:1' }, documentId: 'doc-1', session: 3, expectedRevision: 4 })
  const mismatch = await api.callTool('get_metadata', { nodeId: 'another', cursor: first.nextCursor })
  assert.equal(mismatch.error.code, 'invalid_params')
  assert.equal(calls.at(-1).method, 'page.list')
})

test('get_selection reads ids and summarizes at most the requested nodes', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['a', 'b'] }),
    'node.get': request => ({ id: request.params.id, name: request.params.id, kind: 'rectangle', width: 12, height: 8, node: { id: request.params.id } }),
  })
  const selected = ok(await api.callTool('get_selection', {}, {}))
  assert.deepEqual(selected.result.ids, ['a', 'b'])
  assert.deepEqual(selected.result.nodes.map(node => node.id), ['a', 'b'])
  assert.deepEqual(calls.map(call => call.method), ['selection.get', 'node.get', 'node.get'])
})

test('a packaged stdio session assertion must match the authenticated grant', async () => {
  const calls = []
  const api = new FigmaFacade({ scope: 'read', localSessionId: 'desktop-grant-id', methods: [{ name: 'selection.get' }],
    execute: async request => {
      calls.push(request)
      return { ok: true, method: request.method, documentId: 'doc-1', session: 3, revision: 4,
        result: { ids: [], pageId: 'page-1' } }
    },
  })
  assert.equal((await api.callTool('get_selection', { sessionId: 'another-grant' })).error.code, 'invalid_local_session')
  assert.equal((await api.callTool('get_selection', { sessionId: 3 })).error.code, 'invalid_local_session')
  assert.deepEqual(calls, [])
  ok(await api.callTool('get_selection', { sessionId: 'desktop-grant-id' }))
  assert.deepEqual(calls.map(request => request.params), [{}])
})

test('get_design_context asks for context and HTML/CSS without claiming React output', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['card'] }),
    'context.get': () => ({ nodes: [{ id: 'card', name: 'Card', kind: 'frame' }] }),
    'code.export': () => ({ html: '<main></main>', css: '.card{}', fidelity: 'approximate', warnings: [] }),
  })
  const result = ok(await api.callTool('get_design_context', { clientFrameworks: ['react'] }, {}))
  assert.equal(result.result.format, 'futureox.design-code.v1')
  assert.match(result.result.modelText, /not Figma React/)
  assert.equal(calls.some(call => call.method === 'code.export' && call.params.nodeIds[0] === 'card'), true)
})

test('get_design_context derives a React/Tailwind tree with tokens, pagination, and explicit unmapped fields', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: [] }),
    'context.get': () => ({
      format: 'futureox.design-context.v1',
      page: { id: 'page-1', name: 'Cover', background: '#ffffff' },
      rootIds: ['card'],
      nodes: [
        {
          id: 'card', name: 'Card', kind: 'frame', parentId: null, opacity: 1, blend: 'normal', visible: true,
          geometry: { transform: [1, 0, 0, 1, 10, 20], width: 200, height: 100 },
          layout: { mode: 'vertical', gap: 8, lineGap: 8, padding: [12, 12, 12, 12], wrap: false, justify: 'start', align: 'stretch', columns: 0 },
          fills: [{ kind: 'solid', color: '#112233', opacity: 1, visible: true, angle: 0, stops: [] }],
          strokes: [], effects: [{ kind: 'shadow', visible: true, radius: 4, x: 0, y: 2, spread: 0, color: '#000000', opacity: 0.25 }],
          shape: { radii: [8, 8, 8, 8], clip: false, mask: false }, sizing: { width: 'fixed', height: 'fixed' }, constraints: {},
          tokens: { bindings: { fill: 'brand' }, styleRefs: { text: 'body' } },
        },
        {
          id: 'title', name: 'Title', kind: 'text', parentId: 'card', opacity: 1, blend: 'normal', visible: true,
          geometry: { transform: [1, 0, 0, 1, 0, 0], width: 100, height: 20 },
          layout: { mode: 'none', gap: 0, lineGap: 0, padding: [], wrap: false, justify: 'start', align: 'start', columns: 0 },
          fills: [{ kind: 'solid', color: '#ffffff', opacity: 1, visible: true, angle: 0, stops: [] }],
          strokes: [], effects: [], shape: { radii: [0, 0, 0, 0] }, sizing: { width: 'fixed', height: 'fixed' }, constraints: {},
          tokens: { bindings: {}, styleRefs: {} },
          text: { content: 'Hello & bye', characters: 11, truncated: false, fontSize: 16, runs: 1,
            style: { fontId: 'font-1', weight: 600, lineHeight: 1.5, letterSpacing: 0, align: 'start', wrap: true, direction: 'auto' } },
        },
      ],
      pagination: { offset: 0, returned: 2, total: 3, limit: 2, nextCursor: 'context-v2:next' },
    }),
    'variable.list': () => [{ id: 'brand', name: 'Brand', collection: 'Colors', values: { Light: '#112233' } }],
    'style.list': () => [{ id: 'body', name: 'Body' }],
    'code.export': () => ({ html: '<main></main>', css: '.card{}', fidelity: 'approximate', warnings: [] }),
  })
  const result = ok(await api.callTool('get_design_context', {
    clientFrameworks: ['react'], clientLanguages: ['typescript'], disableCodeConnect: true,
    excludeScreenshot: true, forceCode: true, limit: 2, fileKey: 'figma-file',
  }, {})).result
  assert.equal(result.format, 'futureox.design-code.v1')
  assert.equal(result.language, 'jsx')
  assert.equal(result.notFigmaOutput, true)
  assert.equal(result.fileKeyIgnored, true)
  assert.match(result.code, /export default function Design\(\)/)
  assert.match(result.code, /className="flex flex-col/)
  assert.match(result.code, /bg-\[#112233\]/)
  assert.match(result.code, /text-\[16px\]/)
  assert.match(result.code, /Hello & bye/)
  assert.equal(result.tree.roots[0].children[0].id, 'title')
  assert.equal(result.usedVariables[0], 'brand')
  assert.equal(result.usedStyles[0], 'body')
  assert.ok(result.unmapped.some(entry => entry.nodeId === 'card' && entry.field === 'effects'))
  assert.ok(result.unmapped.some(entry => entry.nodeId === 'title' && entry.field === 'text.style.fontId'))
  assert.equal(result.nextCursor, 'context-v2:next')
  assert.equal(result.truncated, true)
  const firstContext = calls.find(call => call.method === 'context.get')
  assert.equal(firstContext.params.limit, 2)
  ok(await api.callTool('get_design_context', { cursor: 'context-v2:next' }, {}))
  const lastContext = calls.filter(call => call.method === 'context.get').at(-1)
  assert.equal(lastContext.params.cursor, 'context-v2:next')
  assert.equal((await api.callTool('get_design_context', { limit: 41 }, {})).error.code, 'invalid_params')
  assert.equal((await api.callTool('get_design_context', { excludeScreenshot: 'yes' }, {})).error.code, 'invalid_params')
})

test('get_screenshot and single-node download call the CPU export', async () => {
  const preview = { format: 'futureox.design-preview.v1', mimeType: 'image/png', width: 4, height: 4 }
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: [] }),
    'preview.capture': request => ({
      ...preview, nodeIds: request.params.nodeIds, formatName: request.params.format,
      ...(request.params.format === 'pdf' ? {
        mimeType: 'application/pdf',
        dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
      } : {}),
    }),
    'vector.export': () => ({ format: 'futureox.design-vector.v1', content: '<svg/>' }),
  })
  const shot = ok(await api.callTool('get_screenshot', {}, {}))
  assert.equal(shot.method, 'preview.capture')
  assert.equal(calls.at(-1).params.format, 'png')
  assert.equal(calls.at(-1).params.nodeIds, undefined)
  const png = ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'png' }, {}))
  assert.equal(png.result.rawImagesUnsupported, false)
  assert.equal(png.result.urls, false)
  assert.equal(png.result.delivery, 'mcp-resources')
  assert.equal(png.result.temporaryUrls, false)
  assert.equal(png.result.urlExport.supported, false)
  assert.equal(png.result.urlExport.code, 'unsupported_remote_capability')
  assert.equal(JSON.stringify(png.result).includes('http'), false)
  const many = await api.callTool('download_assets', { nodeIds: Array.from({ length: 21 }, (_, i) => `node-${i}`) }, {})
  assert.equal(many.error.code, 'too_many_nodes')
  const pdf = ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'pdf' }, {}))
  assert.equal(pdf.result.mimeType, 'application/pdf')
  assert.deepEqual(calls.at(-1).params, { format: 'pdf', nodeIds: ['icon'] })
  ok(await api.callTool('download_assets', { nodeId: 'icon', defaultFormat: 'svg' }, {}))
  assert.equal(calls.at(-1).method, 'vector.export')
})

test('download_assets batches individual exports against one revision', async () => {
  const { api, calls } = facade({
    'document.get': () => ({}),
    'preview.capture': request => ({
      format: 'futureox.design-preview.v1', mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${Buffer.from(request.params.nodeIds[0]).toString('base64')}`,
    }),
  })
  const result = ok(await api.callTool('download_assets', { nodeId: 'a', nodeIds: ['b', 'a'], defaultScale: 2 }, {}))
  assert.deepEqual(result.result.assets.map(asset => asset.nodeId), ['a', 'b'])
  assert.deepEqual(calls.map(call => call.method), ['document.get', 'preview.capture', 'preview.capture'])
  for (const request of calls.slice(1)) {
    assert.equal(request.documentId, 'doc-1')
    assert.equal(request.session, 3)
    assert.equal(request.expectedRevision, 4)
    assert.equal(request.params.scale, 2)
  }
  const stale = facade({
    'document.get': () => ({}),
    'vector.export': request => ({ content: '<svg/>', revision: request.params.nodeIds[0] === 'b' ? 5 : 4 }),
  }).api
  const failed = await stale.callTool('download_assets', { nodeIds: ['a', 'b'], defaultFormat: 'svg' }, {})
  assert.equal(failed.error.code, 'stale_revision')
  assert.equal(failed.result, undefined)
})

test('download_assets returns twenty real PNG payloads as local resources, never invented URLs', async () => {
  const png = makePng(1, 1, Buffer.from([12, 34, 56, 255]))
  const base64 = png.toString('base64')
  const { api } = facade({
    'document.get': () => ({}),
    'preview.capture': () => ({ format: 'futureox.design-preview.v1', mimeType: 'image/png', dataUrl: `data:image/png;base64,${base64}`, width: 1, height: 1 }),
    'raster.sourceAssets': request => ({ format: 'futureox.design-asset-batch.v1', rawImagesTruncated: false,
      assets: request.params.nodeIds.map(nodeId => ({ nodeId, mimeType: 'image/png', base64 })) }),
  })
  const nodeIds = Array.from({ length: 20 }, (_, index) => `node-${index}`)
  const batch = ok(await api.callTool('download_assets', { nodeIds, defaultFormat: 'png', defaultScale: 2, fileKey: 'figma-file' }, {})).result
  assert.equal(batch.assets.length, 20)
  assert.deepEqual(batch.assets.map(asset => asset.nodeId), nodeIds)
  for (const asset of batch.assets) {
    const decoded = decodePng(Buffer.from(asset.base64, 'base64'))
    assert.deepEqual([decoded.width, decoded.height], [1, 1])
    assert.deepEqual(decoded.pixels, [12, 34, 56, 255])
  }
  assert.equal(batch.delivery, 'mcp-resources')
  assert.equal(batch.temporaryUrls, false)
  assert.equal(batch.urls, false)
  assert.equal(batch.urlExport.supported, false)
  assert.equal(JSON.stringify(batch).includes('http'), false)
  assert.equal((await api.callTool('download_assets', { nodeIds: [...nodeIds, 'twenty-one'] }, {})).error.code, 'too_many_nodes')
  const raw = ok(await api.callTool('download_assets', { nodeIds: ['a', 'b'], rawImagesOnly: true }, {})).result
  assert.equal(raw.delivery, 'mcp-resources')
  assert.equal(raw.assets.length, 2)
  assert.equal(raw.urlExport.code, 'unsupported_remote_capability')
})

test('screenshots pin the selection and forward the requested crop and size', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['icon'] }),
    'preview.capture': request => ({ format: 'futureox.design-preview.v1', parameters: request.params }),
  })
  const shot = ok(await api.callTool('get_screenshot', { maxDimension: 512, contentsOnly: false, enableBase64Response: false }, {}))
  assert.equal(shot.result.inlineImage, false)
  assert.deepEqual(calls.at(-1).params, { format: 'png', maxDimension: 512, contentsOnly: false, pageId: 'page-1', nodeIds: ['icon'] })
  assert.equal(calls.at(-1).expectedRevision, 4)
  for (const args of [{ maxDimension: 0 }, { maxDimension: Infinity }, { contentsOnly: 'true' }, { enableBase64Response: 1 }])
    assert.equal((await api.callTool('get_screenshot', args, {})).error.code, 'invalid_params')
  assert.equal(calls.length, 2)
})

test('get_screenshot forwards Figma size/format parameters and returns decodable PNG pixels without a fake URL', async () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255])
  const png = makePng(2, 2, pixels)
  const { api, calls } = facade({
    'selection.get': () => ({ pageId: 'page-1', ids: ['icon'] }),
    'preview.capture': request => ({
      format: 'futureox.design-preview.v1', mimeType: 'image/png', width: 2, height: 2,
      naturalWidth: 20, naturalHeight: 20, dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      parameters: request.params,
    }),
  })
  const shot = ok(await api.callTool('get_screenshot', { nodeId: 'icon', contentsOnly: true }, {})).result
  assert.deepEqual(calls.at(-1).params, { format: 'png', maxDimension: 1024, contentsOnly: true, nodeIds: ['icon'] })
  assert.equal(shot.temporaryUrl, false)
  assert.equal(shot.delivery, 'mcp-image-or-resource')
  assert.equal(shot.urlExport.supported, false)
  assert.equal(shot.urlExport.code, 'unsupported_remote_capability')
  assert.equal(shot.naturalWidth, 20)
  const decoded = decodePng(Buffer.from(shot.dataUrl.slice('data:image/png;base64,'.length), 'base64'))
  assert.deepEqual([decoded.width, decoded.height], [2, 2])
  assert.deepEqual(decoded.pixels, [...pixels])
  ok(await api.callTool('get_screenshot', { nodeId: 'icon', scale: 2 }, {}))
  assert.equal(calls.at(-1).params.scale, 2)
  assert.equal(calls.at(-1).params.maxDimension, undefined)
  ok(await api.callTool('get_screenshot', { nodeId: 'icon', format: 'webp', maxDimension: 512 }, {}))
  assert.equal(calls.at(-1).params.format, 'webp')
  assert.equal((await api.callTool('get_screenshot', { nodeId: 'icon', format: 'pdf' }, {})).error.code, 'invalid_params')
})

test('get_variable_defs keeps selection bindings and their transitive aliases at one revision', async () => {
  const { api, calls } = facade({
    'selection.get': () => ({ ids: ['label'] }),
    'node.get': () => ({ node: { bindings: { fill: 'brand' }, styleRefs: { text: 'body' } } }),
    'variable.list': () => [
      { id: 'brand', values: { Light: { alias: 'palette' }, Dark: { alias: 'dark' } } },
      { id: 'palette', values: { Light: { alias: 'literal' } } },
      { id: 'literal', values: { Light: '#112233' } },
      { id: 'dark', values: { Dark: '#332211' } },
      { id: 'gap', values: { Light: 12 } },
    ],
    'style.list': () => [{ id: 'body', name: 'Body' }, { id: 'other', name: 'Other' }],
  })
  const defs = ok(await api.callTool('get_variable_defs', {}, {}))
  assert.deepEqual(defs.result.variables.map(item => item.id), ['brand', 'palette', 'literal', 'dark'])
  assert.deepEqual(defs.result.styles.map(item => item.id), ['body'])
  assert.equal(defs.result.librarySupport, false)
  assert.equal(defs.result.libraries.status, 'unsupported')
  assert.equal(defs.result.libraries.code, 'unsupported_remote_capability')
  assert.match(defs.result.libraries.message, /Team libraries/)
  assert.equal(defs.result.fileKeyIgnored, false)
  assert.ok(calls.slice(1).every(call => call.documentId === 'doc-1' && call.session === 3 && call.expectedRevision === 4))
  const explicit = ok(await api.callTool('get_variable_defs', { nodeId: 'label' }, {}))
  assert.deepEqual(explicit.result, defs.result)
})

test('use_figma compiles structured writes into one batch and refuses plugin source without a bridge', async () => {
  const { api, calls } = facade({
    'document.get': () => ({ revision: 8 }),
    'node.get': () => ({ revision: 8, node: { transform: [1, 0, 0, 1, 10, 20] } }),
    'batch.apply': request => ({ applied: request.params.operations.length, revision: 9 }),
  }, { pluginBridge: null })
  const created = ok(await api.callTool('use_figma', {
    description: 'Add a label',
    operations: [
      { op: 'create', kind: 'rectangle', x: 0, y: 0, width: 100, height: 40, name: 'Card', fill: '#112233' },
      { op: 'update', nodeId: 'title', x: 30, text: 'Hello' },
      { op: 'select', nodeIds: [] },
    ],
  }, {}))
  assert.equal(created.result.revision, 9)
  const batch = calls.find(call => call.method === 'batch.apply')
  assert.equal(batch.expectedRevision, 8)
  assert.equal(batch.params.operations[0].method, 'node.create')
  assert.deepEqual(batch.params.operations[0].params.patch.fills[0], { kind: 'solid', color: '#112233', opacity: 1, angle: 0, stops: [] })
  assert.deepEqual(batch.params.operations[1], { method: 'node.patch', params: { ids: ['title'], patch: { transform: { x: 30 } } } })
  assert.equal(batch.params.operations[2].params.patch.text, 'Hello')
  assert.equal(batch.params.operations[3].method, 'selection.set')
  calls.length = 0
  const blocked = await api.callTool('use_figma', { description: 'Run plugin', code: 'FIGMA_PLUGIN_SOURCE_SENTINEL' }, {})
  assert.equal(blocked.error.code, 'plugin_host_unavailable')
  assert.equal(calls.length, 0)
  assert.equal(JSON.stringify(blocked).includes('FIGMA_PLUGIN_SOURCE_SENTINEL'), false)
})

test('registered plugin bridge receives source and the facade does not eval it', async () => {
  const seen = []
  const bridge = { run: async input => { seen.push(input.code); return { ok: true, method: 'use_figma', documentId: input.documentId, session: input.session, revision: input.revision, result: { forwarded: true } } } }
  registerFigmaPluginBridge(bridge)
  try {
    const { api, calls } = facade({ 'document.get': () => ({ revision: 2 }) })
    const result = ok(await api.callTool('use_figma', { description: 'Rename', code: 'figma.currentPage.selection' }, {}))
    assert.equal(result.result.forwarded, true)
    assert.deepEqual(seen, ['figma.currentPage.selection'])
    assert.deepEqual(calls.map(call => call.method), ['document.get'])
  } finally { registerFigmaPluginBridge(null) }
})

test('read-only scope rejects writes before calling the Design API', async () => {
  const { api, calls } = facade({}, { scope: 'read' })
  assert.deepEqual(api.listTools().map(tool => tool.name), ['get_metadata', 'get_selection', 'get_design_context', 'get_screenshot', 'get_variable_defs', 'download_assets', ...FIGMA_COMPATIBILITY_TOOLS.map(entry => entry.name)])
  const write = await api.callTool('use_figma', { description: 'Edit', operations: [{ op: 'delete', nodeId: 'a' }] }, {})
  const open = await api.callTool('open_document', { rootHandle: 'root', documentHandle: 'doc', mutationId: 'open-1' }, {})
  assert.equal(write.error.code, 'read_only')
  assert.equal(open.error.code, 'read_only')
  assert.equal(calls.length, 0)
})

test('open_document reports a missing workspace grant and otherwise forwards handles', async () => {
  const missing = facade({ 'document.get': () => ({}) }, { methods: METHODS.filter(name => name !== 'workspace.open') })
  assert.equal(missing.api.listTools().some(tool => tool.name === 'use_figma'), true)
  assert.equal(missing.api.listTools().some(tool => tool.name === 'open_document'), false)
  const unavailable = await missing.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {})
  assert.equal(unavailable.error.code, 'open_unavailable')
  assert.equal(missing.calls.length, 0)
  const present = facade({
    'document.get': () => ({ revision: 5 }),
    'workspace.open': request => ({ handle: request.params.documentHandle, revision: 5 }),
  })
  assert.equal(present.api.listTools().some(tool => tool.name === 'open_document'), true)
  const opened = ok(await present.api.callTool('open_document', { rootHandle: 'root', documentHandle: 'saved', mutationId: 'open-1' }, {}))
  assert.equal(opened.result.handle, 'saved')
  assert.equal(present.calls.at(-1).params.mutationId, 'open-1')
  assert.equal(present.calls.at(-1).expectedRevision, 5)
})

test('stdio tool text for get_metadata is the XML outline', async t => {
  const { api } = facade({ 'page.list': () => ({ pages: [{ id: 'page-1', name: 'Cover' }] }) })
  const input = new PassThrough(), output = new PassThrough()
  let bytes = ''
  const messages = []
  output.on('data', chunk => { bytes += chunk; let index; while ((index = bytes.indexOf('\n')) !== -1) { messages.push(JSON.parse(bytes.slice(0, index))); bytes = bytes.slice(index + 1) } })
  const server = new DesignMcpServer({ input, output, diagnostics: new PassThrough(), backend: api, instructions: FIGMA_MCP_INSTRUCTIONS }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy() })
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  const wait = async count => { const end = Date.now() + 1000; while (messages.length < count) { if (Date.now() > end) throw new Error(`expected ${count}`); await delay(2) }; return messages.at(-1) }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'figma-client', version: '1' } } })
  const initialized = await wait(1)
  assert.match(initialized.result.instructions, /plugin_host_unavailable/)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_metadata', arguments: {} } })
  const call = await wait(2)
  assert.equal(call.result.isError, false)
  assert.match(call.result.content[0].text, /^<canvas /)
  assert.equal(call.result.structuredContent.result.modelText, undefined)
})
