// @ts-expect-error jsdom is a test-only dependency
import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createDesignAutomation } from './core'
import { exportExtensions } from './export'
import { readDesignFile } from '../persistence'

test('real MCP SVGZ export/import roundtrip and UI file import use the bounded shared decoder', async () => {
  const dom = new JSDOM(''); vi.stubGlobal('DOMParser', dom.window.DOMParser)
  const document = blank(), shape = node('rectangle', 0, 0, 100, 80)
  document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
  const editor = new Editor(document), destination = new Editor(blank())
  const sourceApi = createDesignAutomation(editor, exportExtensions), targetApi = createDesignAutomation(destination, exportExtensions)
  try {
    const result = sourceApi.execute({ method: 'vector.export', params: { compression: 'gzip' } })
    expect(result.ok).toBe(true); if (!result.ok) return
    const output = result.result as { base64: string }
    const fresh = () => { const read = targetApi.execute({ method: 'document.export' }); return { documentId: read.documentId, session: read.session, expectedRevision: read.revision } }
    const imported = targetApi.execute({ ...fresh(), method: 'svg.import', params: { format: 'svgz', base64: output.base64 } })
    expect(imported.ok, JSON.stringify(imported)).toBe(true)
    expect(Object.keys(destination.state.doc.nodes).length).toBeGreaterThan(0)
    const bytes = Uint8Array.from(atob(output.base64), c => c.charCodeAt(0))
    const file = { name: 'roundtrip.svgz', size: bytes.length, arrayBuffer: async () => bytes.buffer } as File
    expect(Object.keys((await readDesignFile(file)).document.nodes).length).toBeGreaterThan(0)
    const before = JSON.stringify(destination.state.doc)
    for (const params of [{ format: 'svgz', base64: 'bad' }, { format: 'svgz', base64: output.base64, content: '<svg/>' }, { format: 'svg', base64: output.base64 }, { format: 'svg', content: '<not-svg/>' }]) expect(targetApi.execute({ ...fresh(), method: 'svg.import', params }).ok).toBe(false)
    expect(JSON.stringify(destination.state.doc)).toBe(before)
  } finally { editor.dispose(); destination.dispose(); vi.unstubAllGlobals(); dom.window.close() }
})
