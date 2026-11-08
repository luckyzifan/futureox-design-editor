import { expect, test } from 'vitest'
import { importFigComponents } from './import-fig-components'
import { blank, node, paint, stroke } from './model'

test('component properties with several targets and stroke overrides are kept', () => {
  const doc = blank('组件')
  const main = node('frame', 0, 0, 120, 48)
  const labelFrame = node('frame', 0, 0, 48, 20)
  const labelText = node('text', 0, 0, 40, 16)
  labelText.text = 'Label'
  const instance = node('frame', 0, 60, 120, 48)
  main.children = [labelFrame.id]
  labelFrame.children = [labelText.id]
  doc.nodes = { [main.id]: main, [labelFrame.id]: labelFrame, [labelText.id]: labelText, [instance.id]: instance }
  const records = new Map<string, any>([
    ['sym', { type: 'SYMBOL', componentPropDefs: [
      { id: { sessionID: 1, localID: 8 }, name: 'Label', type: 'BOOL', initialValue: { boolValue: true } },
      { id: { sessionID: 1, localID: 9 }, name: 'Input', type: 'BOOL', initialValue: { boolValue: true } },
    ] }],
    ['frame', { type: 'FRAME', name: 'Label', componentPropRefs: [{ defID: { sessionID: 1, localID: 8 }, componentPropNodeField: 'VISIBLE' }] }],
    ['text', { type: 'TEXT', name: 'Label', componentPropRefs: [{ defID: { sessionID: 1, localID: 8 }, componentPropNodeField: 'VISIBLE' }] }],
    ['inst', { type: 'INSTANCE', symbolData: { symbolID: 'sym', symbolOverrides: [{
      guidPath: { guids: ['text'] },
      styleIdForFill: { guid: { sessionID: 4294967295, localID: 4294967295 } },
      strokePaints: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, opacity: 1, visible: true }],
      strokeWeight: 2,
    }] } }],
  ])
  const ids = new Map([['sym', main.id], ['frame', labelFrame.id], ['text', labelText.id], ['inst', instance.id]])
  const warnings = new Set<string>()
  importFigComponents(doc, records, ids, () => paint('#000000'), (record) => [{ ...stroke('#123456', record.strokeWeight ?? 1) }], { add: (message) => warnings.add(message) })
  const properties = doc.nodes[main.id].component!.properties
  expect(properties['1:8'].targetKey).toBe(labelFrame.id)
  expect(properties['1:8'].alsoTargets).toEqual([labelText.id])
  expect(properties['1:9'].unbound).toBe(true)
  expect([...warnings].some(message => message.includes('没有唯一目标'))).toBe(false)
  const overrides = doc.nodes[instance.id].instance!.overrides[labelText.id]
  expect(overrides.strokes).toEqual([expect.objectContaining({ width: 2 })])
  expect([...warnings].some(message => message.includes('styleIdForFill') || message.includes('strokePaints'))).toBe(false)
})
