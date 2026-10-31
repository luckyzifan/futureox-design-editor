import {expect,test} from 'vitest'
import {blank,node,paint} from './model'
import {querySelection} from './selection-queries'
test('same fill ignores generated paint IDs and excludes locked targets',()=>{
 const d=blank(),a=node('rectangle',0,0,20,20),b=node('ellipse',50,0,20,20),c=node('rectangle',100,0,20,20)
 a.fills=[paint('#123456')];b.fills=[paint('#123456')];c.fills=[paint('#123456')];c.locked=true
 d.nodes={[a.id]:a,[b.id]:b,[c.id]:c};d.pages[0].children=[a.id,b.id,c.id]
 expect(querySelection(d,d.pages[0].id,[a.id],'fill')).toEqual([a.id,b.id])
 expect(querySelection(d,d.pages[0].id,[a.id],'inverse')).toEqual([b.id])
})
test('matching layers follow hierarchy across named frames without matching unrelated paths',()=>{
 const d=blank(),frames=[node('frame',0,0,100,100),node('frame',150,0,100,100)],children=frames.map(()=>node('rectangle',10,10,20,20))
 frames.forEach((f,i)=>{f.name=`Screen ${i}`;children[i].name='Icon';f.children=[children[i].id];d.nodes[f.id]=f;d.nodes[children[i].id]=children[i]});d.pages[0].children=frames.map(f=>f.id)
 expect(querySelection(d,d.pages[0].id,[children[0].id],'matching')).toEqual(children.map(n=>n.id))
 children[1].name='Other';expect(querySelection(d,d.pages[0].id,[children[0].id],'matching')).toEqual([children[0].id])
})
