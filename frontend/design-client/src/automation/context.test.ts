import { createHash } from 'node:crypto'
import { Editor } from '../engine'
import { createDesignAutomation } from './core'
import { describe, expect, it } from 'vitest'
import { blank, node, paint, defaultLayout } from '../model'
import { emptySystem } from '../design-system'
import { componentFixture } from '../component-fixtures'
import { getDesignContext, checkDesign, contextEntries, safeWebUrl, referenceHash, contextExtensions } from './context'

function fixture() {
  const document = blank('Context fixture'), frame = node('frame'), text = node('text', 12, 10, 100, 30)
  frame.layout = defaultLayout(); frame.children = [text.id]; text.text = 'Hello design'
  document.pages[0].children = [frame.id]; document.nodes = { [frame.id]: frame, [text.id]: text }
  return { document, frame, text }
}
describe('bounded design context', () => {
  it('returns real authored layout, text, token aliases and image material references without binary content', () => {
    const { document, frame, text } = fixture()
    document.schemaVersion = 4; document.designSystem = emptySystem()
    document.designSystem.collections.colors = { name: 'Colors', modes: ['light'], defaultMode: 'light' }
    document.designSystem.variables.base = { name: 'Base', collection: 'colors', kind: 'color', values: { light: '#ff0000' } }
    document.designSystem.variables.brand = { name: 'Brand', collection: 'colors', kind: 'color', values: { light: { alias: 'base' } } }
    text.bindings = { 'fills.0.color': 'brand' }
    const image = paint('#fff', 'image'); image.image = `data:image/png;base64,${'A'.repeat(100000)}`; frame.fills = [image]
    const result = getDesignContext(document)
    expect(result.nodes[0].layout).toMatchObject({ mode: 'horizontal', gap: 12 })
    expect(result.nodes[1].text?.content).toBe('Hello design')
    expect(result.tokens.variables.map(v => v.id)).toEqual(['brand', 'base'])
    expect(result.assets[0]).toMatchObject({ source: 'embedded', characters: image.image.length, nodeIds: [frame.id] })
    expect(result.nodes[0].materialRefs[0].assetId).toBe(result.assets[0].id)
    expect(JSON.stringify(result)).not.toContain('A'.repeat(100))
    result.nodes[0].geometry.transform[4] = 900
    expect(frame.transform[4]).toBe(0)
  })
  it('reports actual component definitions, instance references and properties', () => {
    const { doc, ids } = componentFixture()
    const result = getDesignContext(doc, { nodeIds: [ids.button, ids.a], maxDepth: 2 })
    expect(result.nodes.find(n => n.id === ids.button)?.components).toMatchObject({ definition: { properties: expect.any(Object) } })
    expect(result.nodes.find(n => n.id === ids.a)?.components).toMatchObject({ instance: { componentId: ids.button } })
  })
  it('pages a 3500-node document without duplicates or omitted nodes and stays under 1 MiB', () => {
    const document = blank('Large graph')
    for (let i = 0; i < 3500; i++) { const item = node('rectangle', i, i, 10, 10); document.nodes[item.id] = item; document.pages[0].children.push(item.id) }
    const found: string[] = []; let cursor: string | undefined
    do {
      const result = getDesignContext(document, { limit: 137, cursor })
      expect(result.nodes.length).toBeLessThanOrEqual(137)
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(1024 * 1024)
      found.push(...result.nodes.map(n => n.id)); cursor = result.pagination.nextCursor ?? undefined
    } while (cursor)
    expect(found).toEqual(document.pages[0].children)
    expect(new Set(found).size).toBe(3500)
  })
  it('binds cursors to page, selection, depth and graph order', () => {
    const { document, frame } = fixture()
    const first = getDesignContext(document, { limit: 1 })
    expect(() => getDesignContext(document, { cursor: first.pagination.nextCursor!, maxDepth: 0 })).toThrow('cursor')
    frame.children.push(frame.children.shift()!)
    const extra = node('rectangle'); document.nodes[extra.id] = extra; frame.children.push(extra.id)
    expect(() => getDesignContext(document, { cursor: first.pagination.nextCursor! })).toThrow('cursor')
    expect(() => getDesignContext(document, { cursor: 'context-v1:bad:Infinity' })).toThrow('cursor')
  })
  it('rejects context and inspection continuations after a real API text-only mutation', () => {
    const { document, text } = fixture(), editor = new Editor(document), api = createDesignAutomation(editor, contextExtensions)
    try {
      for (const method of ['context.get', 'design.check']) {
        const first = api.execute({ method, params: { limit: 1 } })
        expect(first.ok).toBe(true)
        if (!first.ok) throw new Error(first.error.message)
        const cursor = (first.result as { pagination: { nextCursor: string } }).pagination.nextCursor
        const next = api.execute({ method, params: { limit: 1, cursor } })
        expect(next.ok).toBe(true)
        const update = api.execute({ method: 'node.update', documentId: first.documentId, session: first.session, expectedRevision: first.revision, params: { ids: [text.id], patch: { text: `Changed during ${method} paging` } } })
        expect(update.ok).toBe(true)
        const stale = api.execute({ method, params: { limit: 1, cursor } })
        expect(stale.ok).toBe(false)
        if (!stale.ok) expect(stale.error.message).toContain('stale context cursor')
      }
    } finally { api.dispose(); editor.dispose() }
  })
  it('binds explicit revision and session values without relying on hash collisions', () => {
    const { document } = fixture()
    const cursor = getDesignContext(document, { limit: 1 }, { revision: 3, session: 7 }).pagination.nextCursor!
    expect(() => getDesignContext(document, { cursor }, { revision: 4, session: 7 })).toThrow('cursor')
    expect(() => getDesignContext(document, { cursor }, { revision: 3, session: 8 })).toThrow('cursor')
    expect(() => getDesignContext(document, { cursor })).toThrow('cursor')
  })
  it('matches SHA-256 content identities at padding boundaries, Unicode and large input', () => {
    for (const source of ['', 'abc', '设计 🖼️', ...[55, 56, 63, 64, 65, 1000000].map(n => 'a'.repeat(n))])
      expect(referenceHash(source)).toBe(createHash('sha256').update(source).digest('hex'))
  })
  it('supports bounded subtree drilldown and rejects invalid limits, cycles and page scope', () => {
    const { document, frame, text } = fixture()
    const shallow = getDesignContext(document, { nodeIds: [frame.id, text.id], maxDepth: 0 })
    expect(shallow.rootIds).toEqual([frame.id]); expect(shallow.nodes).toHaveLength(1)
    expect(shallow.warnings[0].code).toBe('DEPTH_LIMIT')
    for (const limit of [0, -1, 501, 2.5, NaN]) expect(() => getDesignContext(document, { limit })).toThrow()
    expect(() => contextEntries(document, { nodeIds: [] })).toThrow()
    expect(() => getDesignContext(document, { nodeIds: ['missing'] })).toThrow('selected page')
    text.children = [frame.id]
    expect(() => getDesignContext(document)).toThrow('cyclic')
  })
  it('bounds giant text and child lists with explicit truncation markers', () => {
    const { document, frame, text } = fixture(); text.text = 'x'.repeat(100000)
    for (let i = 0; i < 100; i++) { const child = node('rectangle'); frame.children.push(child.id); document.nodes[child.id] = child }
    const result = getDesignContext(document, { limit: 2 })
    expect(result.nodes[0].children).toHaveLength(64); expect(result.nodes[0].childCount).toBe(101)
    expect(result.nodes[1].text).toMatchObject({ truncated: true, characters: 100000 })
    expect(result.nodes[1].text?.content).toHaveLength(2048)
  })
  it('allows only safe, explicit HTTP(S) URLs', () => {
    for (const input of ['javascript:alert(1)', '//evil.test', 'data:image/svg+xml,<svg/>', 'https://user:pass@evil.test', 'https://example.test/\nfoo', 'file:///tmp/private', 'https://example.test/" onload="run']) expect(safeWebUrl(input)).toBeUndefined()
    expect(safeWebUrl('https://example.test/a.png?v=1&x=2')).toBe('https://example.test/a.png?v=1&x=2')
  })
})
describe('AI self-inspection', () => {
  it('reports native text ink and child overflow with node IDs and honest heuristic labels', () => {
    const { document, frame, text } = fixture(); delete frame.layout
    text.transform[4] = 200; text.width = 5; text.text = 'This does not fit in five pixels'; text.fontSize = 20
    const result = checkDesign(document)
    expect(result.checkedNodes).toBe(2)
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CHILD_OUTSIDE_PARENT', nodeId: text.id, certainty: 'heuristic' }),
      expect.objectContaining({ code: 'TEXT_INK_OUTSIDE_BOX', nodeId: text.id, certainty: 'heuristic' }),
    ]))
    expect(result.issues.some(i => i.code.includes('OVERLAP'))).toBe(false)
  })
  it('does not claim invalid documents passed inspection', () => {
    const { document, frame } = fixture(); frame.children.push('missing')
    const result = checkDesign(document)
    expect(result.complete).toBe(false); expect(result.issues[0].code).toBe('INVALID_DOCUMENT')
  })
})
