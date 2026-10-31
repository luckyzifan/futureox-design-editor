import { expect, test } from 'vitest'
import { blank, node, paint, stroke, effect } from './model'
import { selectionColors, replaceSelectionColor } from './selection-colors'
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
