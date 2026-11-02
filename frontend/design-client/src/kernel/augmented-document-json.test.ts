import { expect, test, vi } from 'vitest'
import { blank, node } from '../model'
import { augmentedDocumentJson } from './op-sync'

test('a certified document string gains the sync projection without walking node records', () => {
  const doc = blank('Certified')
  const shape = node('rectangle', 3, 4, 20, 30)
  shape.name = 'marker-node'
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const certified = JSON.stringify(doc)
  const stringify = vi.spyOn(JSON, 'stringify')
  const spliced = augmentedDocumentJson(doc, certified)
  const walkedDocument = stringify.mock.calls.some(([value]) => value === doc || (value && typeof value === 'object' && 'nodes' in value && (value as { nodes: object }).nodes === doc.nodes))
  stringify.mockRestore()
  expect(walkedDocument).toBe(false)
  expect(JSON.parse(spliced)).toEqual(JSON.parse(augmentedDocumentJson(doc)))
  expect(JSON.parse(spliced).nodes[shape.id].name).toBe('marker-node')
})

test('page ids keep projection precedence when a node reuses that id', () => {
  const doc = blank('Overlap')
  const pageId = doc.pages[0].id
  const shape = node('rectangle', 0, 0, 10, 10)
  shape.id = pageId
  doc.nodes[pageId] = shape
  doc.pages[0].children = []
  const spliced = JSON.parse(augmentedDocumentJson(doc, JSON.stringify(doc)))
  expect(spliced.nodes[pageId].kind).toBe('page')
  expect(JSON.parse(augmentedDocumentJson(doc)).nodes[pageId].kind).toBe('page')
})
