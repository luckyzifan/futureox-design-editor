import { expect, test } from 'vitest'
import { blank, node, paint } from './model'
import { diffDocuments } from './document-diff'

test('stable IDs classify additions, removals, movement, text and style field values', () => {
  const a = blank(), text = node('text'), removed = node('rectangle'), added = node('ellipse')
  text.text = 'Before'; text.fills = [paint('#ff0000')]
  a.nodes = { [text.id]: text, [removed.id]: removed }; a.pages[0].children = [text.id, removed.id]
  const b = structuredClone(a)
  b.nodes[text.id].text = 'After'; b.nodes[text.id].fills[0].color = '#0000ff'
  b.nodes[text.id].transform[4] = 42
  delete b.nodes[removed.id]; b.nodes[added.id] = added; b.pages[0].children = [added.id, text.id]
  const changes = diffDocuments(a, b)
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: text.id, kind: 'text', before: 'Before', after: 'After' }),
    expect.objectContaining({ id: text.id, kind: 'style', field: '填充.0.color', before: '#ff0000', after: '#0000ff' }),
    expect.objectContaining({ id: text.id, kind: 'move', field: '位置 / 变换.4', after: '42' }),
    expect.objectContaining({ id: text.id, kind: 'move', field: '所属容器 / 顺序' }),
    expect.objectContaining({ id: removed.id, kind: 'delete' }),
    expect.objectContaining({ id: added.id, kind: 'add' }),
  ]))
  expect(diffDocuments(a, structuredClone(a))).toEqual([])
})
test('asset payloads never appear in diff; key ordering is immaterial', () => {
  const a = blank(), n = node('rectangle'); n.fills = [paint()]; n.fills[0].image = 'short-secret-image'
  a.nodes[n.id] = n; a.pages[0].children = [n.id]
  const b = structuredClone(a); b.nodes[n.id].fills[0].image = 'different-secret-image'
  b.fonts = { test: { family: 'Test', data: 'secret-font-payload' } }
  const report = JSON.stringify(diffDocuments(a, b))
  expect(report).not.toContain('secret'); expect(report).toContain('字体资源'); expect(report).toContain('资源内容已省略')
  const c = structuredClone(a); c.nodes[n.id] = Object.fromEntries(Object.entries(n).reverse()) as typeof n
  expect(diffDocuments(a, c)).toEqual([])
})
