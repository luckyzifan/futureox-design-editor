import { expect, test } from 'vitest'
import { acceptedSourceNativeRegions, visibleSourceNativeRegions, type SourceNativeCoverage } from './source-native-coverage'
import type { SourceCanvasItem, SourceCanvasSnapshot } from './desktop'

const source={token:'native',revision:0,owner:{documentId:'doc',sessionEpoch:1}} as SourceCanvasSnapshot
const view={x:-50,y:0,zoom:1}
const coverage:SourceNativeCoverage={source,frame:{view,width:100,height:100,dpr:2,ids:[1],interaction:false},
  regions:[{x:0,y:0,width:200,height:80},{x:200,y:0,width:100,height:100}]}

test('the thumbnail layer only reveals accepted material pixels within the bitmap footprint',()=>{
  expect(visibleSourceNativeRegions(coverage,source,view,false)).toEqual([{x:50,y:0,width:100,height:80}])
  // A pan moves these same world pixels, without certifying the newly exposed strip.
  expect(visibleSourceNativeRegions(coverage,source,{...view,x:-75},false)).toEqual([{x:50,y:0,width:100,height:80}])
})
test('a source replacement, hidden surface or rejected camera cannot leave a transparent preview hole',()=>{
  for(const next of [{...source,token:'new'},{...source,revision:1},{...source,owner:{...source.owner,sessionEpoch:2}}])
    expect(visibleSourceNativeRegions(coverage,next,view,false)).toEqual([])
  expect(visibleSourceNativeRegions(coverage,source,view,true)).toEqual([])
  expect(visibleSourceNativeRegions(coverage,source,{...view,zoom:32},false)).toEqual([])
})

test('a selected-material receipt keeps neighbouring thumbnails, including early opening snapshots',()=>{
  const items = ['first','selected','next-page'].map((key,index)=>({key,pageId:index===2?'second':'first',
    placed:{x:index*200,y:0,width:100,height:100}})) as SourceCanvasItem[]
  const selected={...source,materialKeys:['selected']}
  const regions=items.map(item=>({...item.placed,materialKey:item.key}))
  expect(acceptedSourceNativeRegions(selected,undefined,items,'first',regions)).toEqual([regions[1]])
  expect(acceptedSourceNativeRegions({...source,openingMaterial:1},undefined,items,'first')).toEqual([items[1].placed])
  expect(acceptedSourceNativeRegions(source,undefined,items,'first')).toEqual(items.slice(0,2).map(item=>item.placed))
  expect(acceptedSourceNativeRegions(selected,regions,items,'first')).toEqual([regions[1]])
  expect(acceptedSourceNativeRegions(selected,[{x:0,y:0,width:100,height:100}],items)).toEqual([])
  // PR57 rebind changes live catalogue keys while the original opening
  // thumbnails and their source positions remain valid.
  const rebound={...source,materialKeys:['rebound-selected']}
  const reboundBox={...items[1].placed,materialKey:'rebound-selected'}
  expect(acceptedSourceNativeRegions(rebound,undefined,items,'first',[reboundBox])).toEqual([reboundBox])
  expect(acceptedSourceNativeRegions(rebound,undefined,items,'first')).toEqual([])
})
