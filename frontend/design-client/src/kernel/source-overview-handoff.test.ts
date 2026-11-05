// @vitest-environment jsdom
import {expect,test} from 'vitest'
import {SourceOverviewHandoff} from './source-overview-handoff'
const source={owner:{documentId:'file',sessionEpoch:1},revision:0,pageId:'page',rasterProfile:'figma' as const,colorManaged:true}
test('only shared material pixels survive navigation and the next source revision revokes them',()=>{
 const parent=document.createElement('div'),canvas=document.createElement('canvas'),carry=new SourceOverviewHandoff()
 const a={materialKey:'a',x:0,y:0,width:40,height:40},b={...a,materialKey:'b',x:200}
 const v={x:-20,y:0,zoom:1}
 expect(carry.hold(canvas,parent,v,200,100,source,[a],2)).toBe(true)
 carry.project(source,[a,b],{x:30,y:0,zoom:2},600,400,2)
 expect(canvas.style.transform).toContain('70px');expect(canvas.parentElement!.style.clipPath).toContain('inset')
 carry.project(source,[b],v,600,400,2)
 expect(canvas.parentElement!.style.clipPath).toBe('inset(100%)')
 carry.project({...source,revision:1},[a],v,600,400,2)
 expect(parent.childElementCount).toBe(0)
})
