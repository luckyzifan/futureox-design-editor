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

test('executable instance overrides land in kernel fields and consumption maps are kept', () => {
  const doc = blank('覆盖')
  const main = node('frame', 0, 0, 120, 80)
  const shape = node('rectangle', 0, 0, 40, 20)
  shape.strokes = [{ ...stroke('#ff0000', 1), align: 'center' }]
  shape.radii = [0, 0, 0, 0]
  const instance = node('frame', 0, 100, 120, 80)
  main.children = [shape.id]
  doc.nodes = { [main.id]: main, [shape.id]: shape, [instance.id]: instance }
  const records = new Map<string, any>([
    ['sym', { type: 'SYMBOL', size: { x: 120, y: 80 }, stackMode: 'VERTICAL', stackSpacing: 4, stackHorizontalPadding: 2, stackVerticalPadding: 2 }],
    ['shape', { type: 'RECTANGLE', parentIndex: { guid: 'sym' } }],
    ['9:3', { type: 'VARIABLE', key: 'width-token', variableResolvedType: 'FLOAT' }],
    ['inst', { type: 'INSTANCE', symbolData: { symbolID: 'sym', symbolOverrides: [
      {
        guidPath: { guids: ['shape'] },
        cornerRadius: 8,
        rectangleTopLeftCornerRadius: 2,
        size: { x: 50, y: 30 },
        strokeAlign: 'INSIDE',
        strokeWeight: 6,
        borderStrokeWeightsIndependent: true,
        borderTopWeight: 1,
        borderRightWeight: 4,
        pluginData: [{ key: 'k', value: 'v' }],
        variableConsumptionMap: { entries: [
          { variableField: 'WIDTH', variableData: { value: { alias: { assetRef: { key: 'width-token' }, guid: { sessionID: 9, localID: 3 } } } } },
          { variableField: 'STROKE_WEIGHT', variableData: { value: { alias: { guid: { sessionID: 9, localID: 3 } } } } },
        ] },
        parameterConsumptionMap: { entries: [{ variableField: 'WIDTH' }] },
      },
    ] } }],
  ])
  const ids = new Map([['sym', main.id], ['shape', shape.id], ['inst', instance.id], ['9:3', 'var-width']])
  const warnings = new Set<string>()
  const receipts = new Map<string, Record<string, string>>()
  importFigComponents(doc, records, ids, () => paint('#000000'), (record) => [{ ...stroke('#123456', record.strokeWeight ?? 1) }], { add: (message) => warnings.add(message) }, receipts)
  const first = doc.nodes[instance.id].instance!.overrides[shape.id]
  expect(first.radii).toEqual([2, 8, 8, 8])
  expect(first.width).toBe(50)
  expect(first.height).toBe(30)
  expect(first.strokes).toEqual([expect.objectContaining({ width: 6, align: 'inside' })])
  expect((first.bindings as Record<string, string>).width).toBe('9:3')
  expect([...warnings].some(message => message.includes('pluginData'))).toBe(true)
  expect([...warnings].some(message => message.includes('borderStrokeWeightsIndependent'))).toBe(true)
  expect([...warnings].some(message => message.includes('variableConsumptionMap.STROKE_WEIGHT'))).toBe(true)
  expect([...warnings].some(message => message.includes('parameterConsumptionMap'))).toBe(true)
  expect([...warnings].some(message => message.includes('cornerRadius') || message.includes('strokeAlign'))).toBe(false)
  const kept = receipts.get(instance.id)?.figOverrideVariableConsumption ?? ''
  expect(kept).toContain('STROKE_WEIGHT')
  expect(kept).toContain('parameterConsumptionMap')
  void bound
})
