import { afterEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Editor } from './engine'
import { blank, node, effect, stroke, defaultLayout, validateDocument } from './model'
import { propertyUnits, dashInUnits } from './property-units'
import { selectionMetric, resizeNodeDimension } from './selection-properties'
import { Inspector } from './Inspector'
// The editor is client-only; SSR assertions use its real current snapshot.
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useSyncExternalStore: (subscribe: any, snapshot: any, server: any) => actual.useSyncExternalStore(subscribe, snapshot, server || snapshot) }
})
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function fixture() {
  const doc = blank(), frame = node('frame', 5704, 96, 256, 256), lens = node('rectangle', 16, 16, 96, 96)
  lens.radii = [16,16,16,16]; lens.strokes = [{ ...stroke(), width: 2, dash: '4 2' }]
  lens.effects = [{ ...effect('glass'), radius: 1.5, glass: { depth: 8, refraction: .5, dispersion: .2, lightAngle: 45, lightIntensity: .5 } }]
  frame.children = [lens.id]; doc.nodes = { [frame.id]: frame, [lens.id]: lens }; doc.pages[0].children = [frame.id]
  doc.schemaVersion = 5; validateDocument(doc)
  const editor = new Editor(doc); editors.push(editor); editor.select([frame.id]); expect(editor.scaleSelection(2)).toBe(true); editor.select([lens.id])
  return { editor, frame, lens }
}
test('live Figma child X/Y/W/H/radii/glass numbers are displayed without changing native fields', () => {
  const { editor, lens } = fixture(), before = JSON.stringify(editor.state.doc), raw = editor.state.doc.nodes[lens.id]
  expect(['x','y','width','height'].map(f => selectionMetric(raw, f as 'x', editor.state.doc))).toEqual([32,32,192,192])
  const html = renderToStaticMarkup(<Inspector editor={editor} />)
  for (const [label,value] of [['圆角',32],['深度',16],['磨砂',3],['粗细',4]])
    expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]+aria-valuenow="${value}"`))
  expect(html).toContain('aria-label="独立圆角"')
  expect(html).toContain('aria-pressed="false"')
  expect(html).not.toContain('aria-label="左上"')
  expect(html).toContain('class="field-grid glass-fields"')
  expect(html).toContain('value="8 4"')
  expect(JSON.stringify(editor.state.doc)).toBe(before)
  expect(raw.width).toBe(96); expect(raw.effects[0].glass!.depth).toBe(8)
  editor.updateProperties([lens.id], n => { n.radii = [16, 8, 16, 16] })
  const mixed = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(mixed).toMatch(/aria-label="左上"[^>]+aria-valuenow="32"/)
  expect(mixed).toMatch(/aria-label="右上"[^>]+aria-valuenow="16"/)
})
test('mixed corner radii show the four Mac corner fields in native units', () => {
  const { editor, lens } = fixture()
  editor.updateProperties([lens.id], n => { n.radii = [1, 2, 3, 4] })
  const html = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(html).toContain('aria-pressed="true"')
  expect(html).toMatch(/aria-label="左上"[^>]+aria-valuenow="2"/)
  expect(html).toMatch(/aria-label="右上"[^>]+aria-valuenow="4"/)
  expect(html).toMatch(/aria-label="右下"[^>]+aria-valuenow="6"/)
  expect(html).toMatch(/aria-label="左下"[^>]+aria-valuenow="8"/)
})
test('an effective width edit is converted once; unrelated material bits and Undo are preserved', () => {
  const { editor, lens } = fixture(), before = editor.state.doc
  editor.updateProperties([lens.id], n => resizeNodeDimension(n, 'width', 240, editor.state.doc))
  const updated = editor.state.doc.nodes[lens.id]
  expect(updated.width).toBe(120); expect(selectionMetric(updated, 'width', editor.state.doc)).toBe(240)
  expect(updated.effects).toEqual(before.nodes[lens.id].effects); expect(updated.strokes).toEqual(before.nodes[lens.id].strokes)
  editor.undo(); expect(editor.state.doc).toEqual(before)
})
test('nested rotated/reflected similarities expose the same units, angles and proportions remain dimensionless', () => {
  const { editor, frame, lens } = fixture()
  editor.updateProperties([frame.id], n => { n.transform = [0, -2, -2, 0, 0, 0] })
  const units = propertyUnits(editor.state.doc, lens.id)
  expect(units).toEqual({ parentX:2,parentY:2,width:2,height:2,x:2,y:2,style:2 })
  expect(selectionMetric(editor.state.doc.nodes[lens.id], 'rotation', editor.state.doc)).toBe(0)
  expect(editor.state.doc.nodes[lens.id].effects[0].glass!.refraction).toBe(.5)
  expect(dashInUnits('4, 2', 2)).toBe('8 4'); expect(dashInUnits('8 4', .5)).toBe('4 2')
  expect(dashInUnits(' , ', 2)).toBe(''); expect(dashInUnits('-0 4', 2)).toBe('0 8')
  expect(() => dashInUnits('-1 2', 2)).toThrow()
  expect(() => dashInUnits('1 nope', 2)).toThrow()
})
test('text size, spacing and layout lengths follow inherited Scale while counts stay unchanged', () => {
  const { editor, frame } = fixture()
  const text = node('text', 20, 20, 100, 30); text.text = 'Scale'; text.fontSize = 12
  editor.change('text', d => { d.nodes[text.id] = text; d.nodes[frame.id].children.push(text.id) })
  editor.select([text.id]); const html = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(html).toMatch(/aria-label="字号"[^>]+aria-valuenow="24"/)
  editor.updateProperties([frame.id], n => { n.layout = defaultLayout() }); editor.select([frame.id])
  const layout = renderToStaticMarkup(<Inspector editor={editor} />)
  expect(layout).toMatch(/aria-label="项目间距"[^>]+aria-valuenow="24"/)
  expect(layout).toMatch(/aria-label="上内边距"[^>]+aria-valuenow="32"/)
})
