import { afterEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from './engine'
import { Inspector } from './Inspector'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { UnitNumberField } from './UnitNumberField'
import { MixedNumberField } from './MixedNumberField'
import { NumberField } from './fields'
import { DraftInput } from './DraftInput'
import { blank, node, stroke, effect, type Matrix } from './model'
import { propertyUnits, hasProportionalStyleUnits, styleUnitDescription, STYLE_UNIT_DESCRIPTION } from './property-units'
import { displayProperties } from './automation/display-properties'
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useSyncExternalStore: (subscribe: any, snapshot: any, server: any) => actual.useSyncExternalStore(subscribe, snapshot, server || snapshot) }
})
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture(matrix: Matrix) {
  const doc = blank(), frame = node('frame', 0, 0, 300, 200), text = node('text', 10, 20, 100, 30)
  frame.transform = matrix; frame.children = [text.id]; text.text = 'Units'; text.fontSize = 12
  text.strokes = [{ ...stroke(), width: 2, dash: '4 2' }]; text.effects = [{ ...effect('shadow'), radius: 3, x: 2, y: 4 }]
  doc.nodes = { [frame.id]: frame, [text.id]: text }; doc.pages[0].children = [frame.id]
  return { doc, frame, text }
}
function input(html: string, label: string) { return html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '' }

test.each([[1,0,0,1,0,0], [2,0,0,2,0,0], [0,2,-2,0,0,0], [0,-2,-2,0,0,0]].map(matrix => ({ matrix: matrix as Matrix })))('uniform rotation/reflection has no style warning: $matrix', ({ matrix }) => {
  const { doc, text } = fixture(matrix)
  expect(hasProportionalStyleUnits(matrix)).toBe(true); expect(styleUnitDescription(doc, [text.id])).toBeUndefined()
  const editor = new Editor(doc); editors.push(editor); editor.select([text.id])
  const html = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(html).not.toContain('property-unit-notice'); expect(input(html, '字号')).not.toContain('aria-description')
})
test.each([[2,0,0,3,0,0], [1,0,1,1,0,0]].map(matrix => ({ matrix: matrix as Matrix })))('nonuniform/skew annotates only style fields while preserving old values: $matrix', ({ matrix }) => {
  const { doc, text } = fixture(matrix), before = JSON.stringify(doc)
  const expected = matrix[0] === 2 ? 3 : (1 + Math.sqrt(5)) / 2
  expect(hasProportionalStyleUnits(matrix)).toBe(false)
  expect(propertyUnits(doc, text.id).style).toBeCloseTo(expected, 12)
  expect(styleUnitDescription(doc, [text.id])).toBe(STYLE_UNIT_DESCRIPTION)
  expect(displayProperties(doc, text.id)).not.toHaveProperty('fontSize')
  const editor = new Editor(doc); editors.push(editor); editor.select([text.id])
  const snapshot = editor.state.doc, html = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(html).toContain('property-unit-notice'); expect(html).toContain('不代表各方向的实际尺寸')
  for (const label of ['字号', '粗细', '模糊', '偏移 X', '偏移 Y', '虚线']) {
    expect(input(html, label), label).toContain('aria-description=')
    expect(input(html, label), label).toContain('最大缩放系数')
  }
  for (const label of ['X', 'Y', 'W', 'H', '旋转 °']) expect(input(html, label), label).not.toContain('aria-description=')
  expect(input(html, '字号')).toContain(`aria-valuenow="${12 * propertyUnits(snapshot, text.id).style}"`)
  expect(editor.state.doc).toBe(snapshot); expect(editor.canUndo).toBe(false); expect(JSON.stringify(doc)).toBe(before)
})
test('classifies the world matrix rather than the node or parent alone', () => {
  const { doc, frame, text } = fixture([2,0,0,3,0,0])
  text.transform = [.5,0,0,1/3,10,20]
  expect(styleUnitDescription(doc, [text.id])).toBeUndefined()
  expect(styleUnitDescription(doc, [frame.id, text.id])).toContain('1/2')
})
test('a description never changes UnitNumberField conversion, limits, callback or label', () => {
  const onChange = vi.fn()
  const field = UnitNumberField({ label: '字号', value: 12, unitScale: 3, min: 1, max: 1024, onChange, unitDescription: STYLE_UNIT_DESCRIPTION })
  expect(field.props).toMatchObject({ label: '字号', value: 36, min: 3, max: 3072, unitDescription: STYLE_UNIT_DESCRIPTION })
  field.props.onChange(45); expect(onChange).toHaveBeenCalledExactlyOnceWith(15)
  const plain = UnitNumberField({ label: '字号', value: 12, unitScale: 3, min: 1, max: 1024, onChange })
  expect(plain.props.value).toBe(field.props.value); expect(plain.props.min).toBe(field.props.min); expect(plain.props.max).toBe(field.props.max)
})
test('mixed fields preserve their label and mixed-value accessible explanation', () => {
  const html = renderToStaticMarkup(<MixedNumberField label="字号" value={undefined} onChange={() => {}} unitDescription={STYLE_UNIT_DESCRIPTION} />)
  expect(input(html, '字号')).toContain('所选图层的数值不同'); expect(input(html, '字号')).toContain('最大缩放系数')
  expect(html).toContain('＊'); expect(html).toContain('placeholder="混合"')
})
test('multi-selection indicates the affected subset without changing per-node values', () => {
  const { doc, text } = fixture([2,0,0,3,0,0]), other = node('text', 0, 0, 100, 30)
  other.text = 'Uniform'; other.fontSize = 12; other.strokes = [{ ...stroke(), width: 2 }]
  doc.nodes[other.id] = other; doc.pages[0].children.push(other.id)
  const editor = new Editor(doc); editors.push(editor); editor.select([text.id, other.id])
  const before = editor.state.doc, nodes = [before.nodes[text.id], before.nodes[other.id]]
  const html = renderToStaticMarkup(<MultiSelectionInspector editor={editor} nodes={nodes} />)
  expect(html).toContain('所选图层中 1/2 层'); expect(html).toContain('property-unit-notice')
  expect(input(html, '字号')).toContain('aria-description='); expect(input(html, 'X')).not.toContain('最大缩放系数')
  expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})

test('numeric titles and independent aria-describedby references survive the extra description', () => {
  const plain = input(renderToStaticMarkup(<NumberField label="字号" value={36} onChange={() => {}} />), '字号')
  const qualified = input(renderToStaticMarkup(<NumberField label="字号" value={36} onChange={() => {}} unitDescription={STYLE_UNIT_DESCRIPTION} />), '字号')
  expect(plain).toContain('title="36"'); expect(qualified).toContain('title="36；')
  expect(qualified).toContain('aria-label="字号"'); expect(qualified).toContain('aria-valuenow="36"')
  // NumberField had no aria-describedby prop before this increment. DraftInput
  // (used by dashes/mixed values) already accepts native independent ARIA IDs.
  const draft = input(renderToStaticMarkup(<DraftInput aria-label="虚线" value="4 2" onCommit={() => {}} title="已有标题" aria-describedby="existing-help" aria-description={STYLE_UNIT_DESCRIPTION} />), '虚线')
  expect(draft).toContain('aria-describedby="existing-help"'); expect(draft).toContain('title="已有标题"')
  expect(draft).toContain('aria-description='); expect(draft).toContain('最大缩放系数')
})


test('scrub accessible description retains drag and modifier instructions with the unit qualifier', () => {
  const render = (unitDescription?: string) => renderToStaticMarkup(<NumberField label="字号" value={36} onChange={() => {}} unitDescription={unitDescription} />).match(/<span class="number-scrub"[^>]*>/)?.[0] ?? ''
  const instructions = '拖动调整数值；Shift 加速，Option 精细调整'
  const plain = render(), qualified = render(STYLE_UNIT_DESCRIPTION)
  expect(plain).toContain(`title="${instructions}"`)
  expect(plain).not.toContain('aria-description=')
  expect(qualified).toContain(`title="${instructions}"`)
  expect(qualified).toContain(`aria-description="${instructions}；${STYLE_UNIT_DESCRIPTION}"`)
  expect(qualified).toContain('aria-label="拖动调整 字号"')
})
