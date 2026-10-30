import {expect,test} from 'vitest'
import {blank,node,defaultLayout} from './model'
import {smartSelection,smartSpacing,smartReorder} from './smart-selection'
import {Editor} from './engine'
import {scene} from './geometry'
test('unequal-size row spacing and reorder preserve geometry, hierarchy and one undo',()=>{
 const d=blank(),ns=[node('rectangle',10,10,30,40),node('rectangle',50,15,50,30),node('rectangle',110,0,20,60)]
 d.nodes=Object.fromEntries(ns.map(n=>[n.id,n]));d.pages[0].children=ns.map(n=>n.id)
 const e=new Editor(d),before=e.state.doc,m=smartSelection(before,before.pages[0].id,ns.map(n=>n.id))!
 expect(m.gapX).toBe(10);expect(m.y).toHaveLength(1)
 e.begin('spacing');e.preview(smartSpacing(before,m,'x',25));e.commit()
 expect(ns.map(n=>e.state.doc.nodes[n.id].transform[4])).toEqual([10,65,140]);e.undo();expect(e.state.doc).toEqual(before)
 e.begin('reorder');e.preview(smartReorder(before,m,[ns[0].id],ns[2].id));e.commit()
 expect(ns.map(n=>e.state.doc.nodes[n.id].transform[4])).toEqual([100,10,70]);expect(e.state.doc.pages[0].children).toEqual(before.pages[0].children)
 e.undo();expect(e.state.doc).toEqual(before);e.dispose()
})
test('grid spacing is independent on each axis; locked/auto-layout/irregular selections are excluded',()=>{
 const d=blank(),ns=[node('rectangle',0,0,20,20),node('rectangle',30,0,20,20),node('rectangle',0,40,20,20),node('rectangle',30,40,20,20)]
 d.nodes=Object.fromEntries(ns.map(n=>[n.id,n]));d.pages[0].children=ns.map(n=>n.id)
 const m=smartSelection(d,d.pages[0].id,ns.map(n=>n.id))!;expect([m.gapX,m.gapY]).toEqual([10,20])
 const patch=smartSpacing(d,m,'y',35);expect(ns.map(n=>patch[n.id].transform.slice(4))).toEqual([[0,0],[30,0],[0,55],[30,55]])
 ns[0].locked=true;expect(smartSelection(d,d.pages[0].id,ns.map(n=>n.id))).toBeNull();ns[0].locked=false
 const frame=node('frame',0,0,200,100);frame.children=ns.map(n=>n.id);frame.layout=defaultLayout();d.nodes[frame.id]=frame;d.pages[0].children=[frame.id]
 expect(smartSelection(d,d.pages[0].id,frame.children)).toBeNull()
})
test('nested rotated parent spacing maps world displacement into local matrices',()=>{
 const d=blank(),p=node('frame',0,0,200,200);p.transform=[0,2,-2,0,300,10]
 const a=node('rectangle',0,0,20,20),b=node('rectangle',30,0,20,20);p.children=[a.id,b.id];d.nodes={[p.id]:p,[a.id]:a,[b.id]:b};d.pages[0].children=[p.id]
 const m=smartSelection(d,d.pages[0].id,p.children)!;expect(m.gapY).toBe(20)
 const patches=smartSpacing(d,m,'y',40);for(const [id,patch] of Object.entries(patches))Object.assign(d.nodes[id],patch)
 const entries=scene(d,d.pages[0].id);expect(entries.find(e=>e.id===b.id)!.bounds.y).toBe(90);expect(d.nodes[b.id].width).toBe(20)
})
