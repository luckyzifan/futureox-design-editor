import { expect, test } from 'vitest'
import { blank, node, effect, paint } from '../model'
import { scene } from '../geometry'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'
import { guardedForegroundSafe } from './guarded-foreground'

function fixture(){
 const document=blank(),frame=node('frame',0,0,1000,1000),text=node('rectangle',20,20,40,20),blur=node('rectangle',500,400,100,60)
 frame.blend=text.blend=blur.blend='normal';frame.children=[text.id,blur.id]
 text.fills=[paint('#123456')];blur.effects=[{...effect('background-blur'),radius:10}]
 document.nodes={[frame.id]:frame,[text.id]:text,[blur.id]:blur};document.pages[0].children=[frame.id]
 const scope=()=>buildInteractionDependencyScope(document,document.pages[0].id,scene(document,document.pages[0].id),[text.id],{zoom:.392,dpr:2,allowFixedBackdrop:true})
 return{document,frame,text,blur,scope}
}
test('distant finite backdrop permits local movement and revokes it before a warm pose enters its support',()=>{
 const f=fixture(),s=f.scope(),safe=(x:number,y:number)=>guardedForegroundSafe(s.foregroundExclusions,s.rootBounds,[f.text.id],new Map([[f.text.id,{x,y}]]),s.parentLinear,.784)
 expect(s.foregroundExclusions).toHaveLength(1);expect(s.localizedBounds.has(f.text.id)).toBe(true)
 expect(s.finalForeground).toBe(false);expect(safe(0,0)).toBe(true);expect(safe(10,10)).toBe(true)
 expect(safe(450,370)).toBe(false);expect(safe(900,700)).toBe(false)
 expect(guardedForegroundSafe(s.foregroundExclusions,s.rootBounds,[f.text.id],null,s.parentLinear,.784)).toBe(false)
})
test('unbounded reads, masks and dependent ancestors keep the full capture',()=>{
 for(const kind of ['glass','mask','ancestor','near'] as const){
  const f=fixture()
  if(kind==='glass')f.blur.effects=[effect('glass')]
  if(kind==='mask')f.blur.mask=true
  if(kind==='ancestor')f.frame.effects=[effect('blur')]
  if(kind==='near')f.blur.transform=[1,0,0,1,30,20]
  expect(f.scope().foregroundExclusions).toBeUndefined()
 }
})
