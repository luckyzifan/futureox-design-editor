import { expect, test } from 'vitest'
import { blank,node,defaultLayout } from './model'
import { gridAxisSpans,gridOverlayRectangles } from './grid-overlay'
test('grid spans are provided by the actual WASM section packer',()=>{
  expect(gridAxisSpans([100,60,100]).spans).toEqual([{start:0,end:100},{start:160,end:260}])
})
test('all solved grid cells are highlighted, without treating another column as a gap',()=>{
  const d=blank(),f=node('frame',0,0,180,160)
  f.layout={...defaultLayout(),mode:'grid',columns:2,gap:10,lineGap:20,padding:[0,0,0,0]}
  d.nodes[f.id]=f;d.pages[0].children=[f.id]
  for(const [x,y,w,h] of [[0,0,80,60],[95,0,80,80],[0,100,80,50],[95,100,80,50]]){const c=node('rectangle',x,y,w,h);d.nodes[c.id]=c;f.children.push(c.id)}
  expect(gridOverlayRectangles(d,f.id).map(({x,y,width,height})=>({x,y,width,height}))).toEqual([
    {x:0,y:0,width:85,height:80},{x:95,y:0,width:85,height:80},
    {x:0,y:100,width:85,height:50},{x:95,y:100,width:85,height:50}])
})
