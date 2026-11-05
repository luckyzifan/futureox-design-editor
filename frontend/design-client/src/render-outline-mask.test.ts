import {expect,test} from 'vitest'
import {node,paint,stroke,blank,validateDocument} from './model'
import {outlineMaskForRendering} from './render-outline-mask'
import {Editor} from './engine'
test('outline rendering preserves authored values and derives only enabled geometry',()=>{
 const mask=node('rectangle',0,0,40,30);mask.mask=true;mask.maskType='outline';mask.opacity=.2
 mask.fills=[{...paint('#000000'),opacity:.1}];mask.strokes=[stroke('#000000',3)];mask.strokes[0].paint.opacity=0
 const before=JSON.stringify(mask),rendered=outlineMaskForRendering(mask)
 expect(JSON.stringify(mask)).toBe(before);expect(rendered.opacity).toBe(1)
 expect(rendered.fills[0]).toMatchObject({kind:'solid',color:'#ffffff',opacity:1})
 expect(rendered.strokes[0].visible).toBe(false);expect(outlineMaskForRendering(mask)).toBe(rendered)
})
test('outline mask remains authored and editable through actual native history and reopening',()=>{
 const d=blank('outline'),mask=node('rectangle',0,0,40,30);mask.mask=true;mask.maskType='outline';mask.fills=[{...paint('#123456'),opacity:.15}]
 d.schemaVersion=4;d.nodes[mask.id]=mask;d.pages[0].children=[mask.id];validateDocument(d)
 const editor=new Editor(d)
 try {
  editor.change('Mask paint edit',doc=>{doc.nodes[mask.id].fills[0].color='#abcdef'})
  expect(editor.state.doc.nodes[mask.id].maskType).toBe('outline')
  editor.undo();expect(editor.state.doc.nodes[mask.id].fills[0].color).toBe('#123456')
  editor.redo();const next=new Editor(JSON.parse(JSON.stringify(editor.state.doc)))
  try{expect(next.state.doc.nodes[mask.id]).toMatchObject({maskType:'outline',fills:[{color:'#abcdef',opacity:.15}]})}finally{next.dispose()}
 } finally {editor.dispose()}
})

test('container outline context normalizes descendants without changing their authored mask flag',()=>{
 const child=node('ellipse',0,0,40,30);child.fills=[{...paint('#123456'),opacity:.1}];child.opacity=.2
 const projected=outlineMaskForRendering(child,true)
 expect(projected.mask).toBe(false);expect(projected.opacity).toBe(1);expect(projected.fills[0].color).toBe('#ffffff')
 expect(outlineMaskForRendering(child)).toBe(child)
})

test('a Sketch shape mask uses its path even with no authored paint',()=>{
 const mask=node('rectangle',0,0,40,30);mask.mask=true;mask.maskType='shape';mask.opacity=0;mask.fills=[]
 const projected=outlineMaskForRendering(mask)
 expect(projected.fills[0].color).toBe('#ffffff');expect(projected.opacity).toBe(1)
 expect(mask.fills).toEqual([]);expect(mask.opacity).toBe(0)
})

test('paint and clip use separate definitions and the same source history after a transparent edit', async () => {
  const {sketchMaskScene} = await import('./render-outline-mask')
  const {svgSource, exportBounds} = await import('./export')
  const d = blank('Sketch poster'), bg = node('rectangle', 0, 0, 100, 80)
  const mask = node('ellipse', 10, 10, 50, 50), stripe = node('rectangle', 0, 30, 100, 10)
  const top = node('rectangle', 78, 10, 15, 15)
  mask.mask = true; mask.maskType = 'shape'; mask.fills = [paint('#2e2e2a')]
  top.maskChain = 'break'; stripe.fills = [paint('#00ffff')]
  d.schemaVersion = 4; d.pages[0].children = [bg.id,mask.id,stripe.id,top.id]
  d.nodes = Object.fromEntries([bg,mask,stripe,top].map(n => [n.id,n]))
  const e = new Editor(d)
  try {
    const render = () => svgSource(e.state.doc,e.state.page).source
    const original = render(), visual = sketchMaskScene(e.state.doc)
    const [before, own, clipped, after] = visual.pages[0].children
    expect([before,own,after]).toEqual([bg.id,mask.id,top.id])
    const [clip, child] = visual.nodes[clipped].children
    expect(child).toBe(stripe.id)
    expect(visual.nodes[clip]).toMatchObject({kind:'ellipse',mask:true,fills:[{color:'#ffffff'}]})
    expect(visual.nodes[own]).toMatchObject({mask:false,fills:[{color:'#2e2e2a'}]})
    expect(original).toContain('mask="url(#mask-'+clipped+')"')
    expect(exportBounds(e.state.doc,e.state.page,0)).toMatchObject({x:0,y:0,width:100,height:80})
    e.change('Clear mask paint',doc=>{doc.nodes[mask.id].fills=[]})
    expect(render()).not.toContain('#2e2e2a')
    expect(e.hit({x:30,y:35},true)).toBe(stripe.id)
    expect(e.hit({x:95,y:35},true)).toBe(bg.id)
    expect(e.hit({x:80,y:15},true)).toBe(top.id)
    e.undo();expect(render()).toBe(original)
    expect(Object.keys(e.state.doc.nodes).sort()).toEqual(Object.keys(d.nodes).sort())
  } finally {e.dispose()}
})
