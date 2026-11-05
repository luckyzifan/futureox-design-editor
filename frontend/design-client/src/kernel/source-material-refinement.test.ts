import {expect,test} from 'vitest'
import {completeMaterialRegions,focalMaterialTiles,materialRegions,orderMaterialTiles,retainsVisibleMaterials} from './source-material-refinement'

test('a whole material is published only with exact surviving tiles and no physical pixel gap',()=>{
  const view={x:0,y:0,zoom:1},viewport={view,width:200,height:100}
  const regions=materialRegions([{x:40,y:38,width:24,height:20,materialKey:'near'},{x:160,y:39,width:16,height:20,materialKey:'far'}],viewport,2)
  const tile=(name:string,x:number)=>({key:name,x:x-1,y:-1,width:202,height:202,gutter:1,zoom:2})
  const left=tile('left',0),right=tile('right',200)
  expect(completeMaterialRegions(regions,[left],2).map(r=>r.material.materialKey)).toEqual(['near'])
  expect(completeMaterialRegions(regions,[left,right],2,[{x:22,y:20,width:1,height:1}]).map(r=>r.material.materialKey)).toEqual(['far'])
  expect(completeMaterialRegions(regions,[left,right],3)).toEqual([])
  expect(orderMaterialTiles([right,left],regions,{x:97,y:44})[0]).toBe(left)
})

test('panning releases offscreen material obligations while preserving detail even at the last visible pixel',()=>{
  const first={x:0,y:48,width:60,height:10,materialKey:'prior'},next={...first,x:180,materialKey:'new'}
  const other={view:{x:-93,y:0,zoom:1},width:200,height:120}
  const edge={...other,view:{...other.view,x:-91.5}}
  expect(retainsVisibleMaterials([first],materialRegions([next],other,2),other,2)).toBe(true)
  expect(retainsVisibleMaterials([first],materialRegions([next],edge,2),edge,2)).toBe(false)
  expect(retainsVisibleMaterials([first],materialRegions([first,next],edge,2),edge,2)).toBe(true)
})

test('focal crops cover the fractional-phase material clip with the original gutter at native density',()=>{
  const view={x:20.25,y:-30.375,zoom:.5},p={view,width:640,height:400}
  const materials=[{x:45,y:83,width:800,height:160,materialKey:'focus'}]
  const phase={x:.5,y:.25},crops=focalMaterialTiles(materials,p,2,phase)!
  expect(crops.length).toBe(2)
  expect(crops.every(t=>t.gutter===1&&t.width<=514&&t.height<=514&&t.phaseX===phase.x&&t.phaseY===phase.y)).toBe(true)
  const regions=materialRegions(materials,p,2)
  expect(completeMaterialRegions(regions,crops,1)).toEqual(regions)
  expect(completeMaterialRegions(regions,crops.slice(1),1)).toEqual([])
})
