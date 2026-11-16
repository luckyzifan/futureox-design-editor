import { expect, test } from 'vitest'
import { blank, node, paint, stroke, effect } from './model'
import { selectionColors, replaceSelectionColor, selectionColorLayerIds } from './selection-colors'
test('collects every selected subtree once across fill stops, strokes, effects and rich text', () => {
  const d = blank(), frame = node('frame'), child = node('text')
  frame.fills = []; frame.children = [child.id]; child.fills = [paint('#ff0000'), { ...paint(), kind: 'linear', stops: [{offset:0,color:'#FF0000'},{offset:1,color:'#0000ff'}] }]
  child.strokes=[stroke()];child.strokes[0].paint.color='#ff0000'
  child.effects=[effect('shadow')];child.effects[0].color='#ff0000'
  child.text='abc';child.textRuns=[{start:0,end:2,color:'#ff0000'}]
  d.nodes={[frame.id]:frame,[child.id]:child};d.pages[0].children=[frame.id]
  const groups=selectionColors(d,[frame.id,child.id]);expect(groups).toHaveLength(2)
  const red=groups.find(group=>group.color==='#ff0000')!;expect(red.uses).toHaveLength(5)
  replaceSelectionColor(child,red.uses,'#112233')
  expect(selectionColors(d,[frame.id]).find(group=>group.color==='#112233')?.uses).toHaveLength(5)
  expect(child.fills[1].stops[1].color).toBe('#0000ff')
})
test('shared color references require explicit local override and leave other bindings intact', () => {
  const d=blank(),n=node('rectangle');n.fills=[paint('#ff0000')];n.bindings={'fills.0.color':'brand',width:'width'};n.styleRefs={fills:'brand-style'}
  d.nodes[n.id]=n;d.pages[0].children=[n.id];const group=selectionColors(d,[n.id])[0]
  expect(group.uses[0].linked).toBe(true)
  expect(()=>replaceSelectionColor(n,group.uses,'#0000ff')).toThrow('本地')
  replaceSelectionColor(n,group.uses,group.color,true)
  expect(n.fills[0].color).toBe('#ff0000');expect(n.bindings).toEqual({width:'width'});expect(n.styleRefs).toBeUndefined()
})
test('layer ids for one color entry keep first-seen order across opacity, gradient stops, and hidden or locked children', () => {
  const d = blank(), frame = node('frame'), solid = node('rectangle'), faded = node('rectangle')
  const gradient = node('rectangle'), otherGradient = node('rectangle'), hidden = node('rectangle'), locked = node('rectangle')
  const hiddenGroup = node('group'), hiddenChild = node('rectangle'), text = node('text'), outside = node('rectangle')
  frame.fills = [paint('#2B74FF')]; frame.children = [solid.id, faded.id, gradient.id, otherGradient.id, hidden.id, locked.id, hiddenGroup.id, text.id]
  solid.fills = [paint('#2B74FF')]; solid.strokes = [stroke('#2B74FF')]
  faded.fills = [paint('#2B74FF')]; faded.fills[0].opacity = 0.4
  gradient.fills = [{ ...paint('#2B74FF'), kind: 'linear', stops: [{ offset: 0, color: '#2B74FF' }, { offset: 1, color: '#00ff00' }] }]
  otherGradient.fills = [{ ...paint(), kind: 'linear', stops: [{ offset: 0, color: '#112233' }, { offset: 1, color: '#445566' }] }]
  hidden.fills = [paint('#2B74FF')]; hidden.visible = false
  locked.fills = [paint('#2B74FF')]; locked.locked = true
  hiddenGroup.visible = false; hiddenGroup.children = [hiddenChild.id]; hiddenChild.fills = [paint('#2B74FF')]
  text.fills = []; text.text = 'a'; text.textRuns = [{ start: 0, end: 1, color: '#2b74ff' }]
  outside.fills = [paint('#2B74FF')]
  d.nodes = Object.fromEntries([frame, solid, faded, gradient, otherGradient, hidden, locked, hiddenGroup, hiddenChild, text, outside].map(n => [n.id, n]))
  d.pages[0].children = [frame.id, outside.id]
  const before = JSON.stringify(d)
  const group = selectionColors(d, [frame.id]).find(entry => entry.color === '#2B74FF')!
  expect(selectionColorLayerIds(group)).toEqual([frame.id, solid.id, faded.id, gradient.id, hidden.id, locked.id, hiddenChild.id, text.id])
  expect(selectionColorLayerIds(group)).not.toContain(otherGradient.id)
  expect(selectionColorLayerIds(group)).not.toContain(outside.id)
  expect(selectionColorLayerIds(group)).not.toContain(hiddenGroup.id)
  expect(faded.fills[0].opacity).toBe(0.4)
  expect(gradient.fills[0].kind).toBe('linear')
  expect(gradient.fills[0].stops[1].color).toBe('#00ff00')
  expect(hidden.visible).toBe(false)
  expect(locked.locked).toBe(true)
  expect(JSON.stringify(d)).toBe(before)
})
