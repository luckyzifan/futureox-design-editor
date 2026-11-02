import { expect, test } from 'vitest'
import { blank, node, validateDocument } from './model'
import { applyFigFacet, figNodeKind, importFigPrototype, parkFigReceipts, type FigReceipts } from './import-fig-nodes'

const warnings = () => {
  const messages: string[] = []
  return { messages, add(message: string) { messages.push(message) } }
}

test('component sets map to frames and unsupported shapes or tables are named', () => {
  const sink = warnings()
  expect(figNodeKind({ type: 'COMPONENT_SET' }, sink)).toBe('frame')
  expect(sink.messages.some((message) => message.includes('COMPONENT_SET'))).toBe(true)
  expect(() => figNodeKind({ type: 'SHAPE_WITH_TEXT', shapeWithTextType: 'HEXAGON' }, sink)).toThrow(/HEXAGON/)
  expect(() => figNodeKind({ type: 'TABLE' }, sink)).toThrow(/TABLE\(0x0/)
  expect(figNodeKind({
    type: 'TABLE',
    tableRowHeights: { entries: [10, 10] },
    tableColumnWidths: { entries: [20] },
  }, sink)).toBe('frame')
})

test('plaintext code blocks and prototype clicks stay non-executable receipts', () => {
  const sink = warnings()
  const receipts: FigReceipts = new Map()
  const code = node('group')
  applyFigFacet(code, { type: 'CODE_BLOCK', codeBlockLanguage: 'PLAINTEXT' }, () => undefined, receipts, sink)
  expect(code.board).toEqual({ kind: 'code-block', language: 'plain' })
  expect(sink.messages).toEqual([])
  const doc = blank()
  const layer = node('rectangle')
  doc.nodes[layer.id] = layer
  doc.pages[0].children = [layer.id]
  const records = new Map([['1:3', { prototypeInteractions: [{ event: { interactionType: 'ON_CLICK' }, actions: [{ navigationType: 'NAVIGATE', transitionNodeID: { sessionID: 1, localID: 3 }, transitionDuration: 0.3 }] }] }]])
  const ids = new Map([['1:3', layer.id]])
  importFigPrototype(records, ids, doc, receipts)
  parkFigReceipts(doc, receipts)
  const stored = (doc.designSystem?.sketchContainers?.nodeMetadata as Record<string, { format: string; bindings: { prototypeFlow: string } }>)[layer.id]
  expect(stored.format).toBe('fig')
  expect(JSON.parse(stored.bindings.prototypeFlow)).toEqual([{
    trigger: 'ON_CLICK', destinationId: layer.id, navigation: 'NAVIGATE', transition: null, duration: 0.3,
  }])
  expect(layer.bindings).toBeUndefined()
  doc.schemaVersion = 4
  expect(() => validateDocument(doc)).not.toThrow()
})
