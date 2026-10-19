import { expect, test } from 'vitest'
import { blank, node, paint, effect, defaultImageAdjust, defaultPatternTile } from './model'
import { supportsEditPreview, retainedSvgMove } from './edit-preview'

test('SVG preview rejects image semantics it cannot render, including stroke paints', () => {
  const d = blank(), n = node('rectangle', 0, 0, 100, 100)
  d.nodes[n.id] = n; d.pages[0].children = [n.id]
  const image = { ...paint('#000000', 'image'), adjust: defaultImageAdjust() }
  n.fills = [image]
  expect(supportsEditPreview(d)).toBe(true)
  image.adjust.exposure = .4
  expect(supportsEditPreview(d)).toBe(false)
  image.adjust.exposure = 0
  n.fills = [{ ...image, tile: defaultPatternTile() }]
  expect(supportsEditPreview(d)).toBe(false)
  n.fills = [{ ...image, blend: 'linear-dodge' }]
  expect(supportsEditPreview(d)).toBe(false)
})

test('other pages and hidden ancestors do not disable the visible page preview', () => {
  const d = blank(), a = node('rectangle', 0, 0, 100, 100), b = node('rectangle', 0, 0, 100, 100)
  b.effects = [effect('glass')]
  d.nodes = { [a.id]: a, [b.id]: b }; d.pages[0].children = [a.id]
  d.pages.push({ ...d.pages[0], id: 'second', children: [b.id] })
  expect(supportsEditPreview(d, d.pages[0].id)).toBe(true)
  expect(supportsEditPreview(d, 'second')).toBe(false)
  a.children = [b.id]; a.visible = false
  expect(supportsEditPreview(d, d.pages[0].id)).toBe(true)
})
test('retained SVG translation rejects moving captures but permits stationary backdrops', () => {
  const d=blank(), moving=node('group',0,0,100,100), child=node('rectangle',0,0,100,100), backdrop=node('rectangle',150,0,100,100)
  moving.children=[child.id];backdrop.effects=[effect('background-blur')]
  d.nodes={[moving.id]:moving,[child.id]:child,[backdrop.id]:backdrop};d.pages[0].children=[moving.id,backdrop.id]
  expect(retainedSvgMove(d,d.pages[0].id,[moving.id])?.id).toBe(moving.id)
  child.effects=[effect('background-blur')]
  expect(retainedSvgMove(d,d.pages[0].id,[moving.id])).toBeNull()
  child.effects=[]; moving.mask=true
  expect(retainedSvgMove(d,d.pages[0].id,[moving.id])).toBeNull()
})
