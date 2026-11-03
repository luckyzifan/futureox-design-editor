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
