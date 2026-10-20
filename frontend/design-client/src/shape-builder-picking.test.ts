import { expect,test } from 'vitest'
import { blank,node } from './model'
import { previewShapeBuilder } from './shape-builder'
import { shapeBuilderSegmentRegions } from './shape-builder-picking'
function ring(){const d=blank(),a=node('ellipse',0,0,100,100),b=node('ellipse',25,25,50,50);d.nodes={[a.id]:a,[b.id]:b};d.pages[0].children=[a.id,b.id];return previewShapeBuilder(d,[a.id,b.id]).regions.filter(r=>r.sources.length===1)}
test('cubic ring sweep respects curved hole and outside intervals',()=>{
  const regions=ring();expect(regions).toHaveLength(1)
  expect(shapeBuilderSegmentRegions(regions,{x:35,y:50},{x:65,y:50})).toEqual([])
  expect(shapeBuilderSegmentRegions(regions,{x:120,y:50},{x:140,y:50})).toEqual([])
  expect(shapeBuilderSegmentRegions(regions,{x:-10,y:50},{x:110,y:50})).toEqual([regions[0].id])
})
test('cubic point/tangent picking is stable and never edits geometry',()=>{
  const regions=ring(),before=JSON.stringify(regions)
  expect(shapeBuilderSegmentRegions(regions,{x:10,y:50},{x:10,y:50})).toEqual([regions[0].id])
  expect(shapeBuilderSegmentRegions(regions,{x:50,y:50},{x:50,y:50})).toEqual([])
  expect(shapeBuilderSegmentRegions(regions,{x:-10,y:-1},{x:110,y:-1})).toEqual([])
  expect(JSON.stringify(regions)).toBe(before)
})
test('nonfinite input fails rather than returning partial selections',()=>{
  expect(()=>shapeBuilderSegmentRegions(ring(),{x:NaN,y:0},{x:10,y:10})).toThrow(/Invalid/)
})
