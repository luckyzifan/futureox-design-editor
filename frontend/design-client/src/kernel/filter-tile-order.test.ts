import { expect, test } from 'vitest'
import { compiledFilterColumnSupport, FilterTileOrder, validTileFillPriorities } from './filter-tile-order'
import { PrepareAhead } from './prepare-ahead'
import { planTiles, type RasterTile } from './tile-cache'
import type { GpuScene } from './gpu/types'

const viewport = { x: 0, y: 0, width: 2560, height: 2048 }
const support = { sourceScale: 2, sourceRows: 3484 }
const tile = (column: number, row: number, extra: Partial<RasterTile> = {}): RasterTile => ({
  key: `${column}/${row}`, x: column * 512 - 1, y: row * 512 - 1, width: 514, height: 514, zoom: 1, ...extra,
})

test('first tile and immutable original indices survive column planning; nearer endpoint is visited first', () => {
  const tiles = [tile(2,1), tile(1,1), tile(2,2), tile(2,3), tile(2,0), tile(1,0)]
  const before = structuredClone(tiles), order = new FilterTileOrder(tiles, tiles.map(() => 0), viewport)
  const visited: number[] = []
  for (let position = 0; position < tiles.length; position++) {
    visited.push(order.indexAt(position)); order.chooseNext(position, support)
  }
  expect(visited.slice(0,4)).toEqual([0,4,2,3])
  expect([...visited].sort()).toEqual([0,1,2,3,4,5]); expect(tiles).toEqual(before)
})

test('holes remain ahead of coarse and sharp refinement even when another tier is in the cached column', () => {
  const tiles = [tile(0,1),tile(1,1),tile(0,0),tile(1,0),tile(0,2),tile(1,2)]
  const priorities = [0,0,1,1,2,2] as const, order = new FilterTileOrder(tiles,priorities,viewport), seen: number[] = []
  for(let at=0;at<tiles.length;at++){seen.push(order.indexAt(at));order.chooseNext(at,support)}
  expect(seen[0]).toBe(0);expect(seen[1]).toBe(1)
  expect(seen.map(index=>priorities[index])).toEqual([0,0,1,1,2,2])
})

test('absent hints/support, prefetch and offscreen barriers preserve original order', () => {
  const tiles=[tile(0,1),tile(1,1),tile(0,0)]
  for(const order of [new FilterTileOrder(tiles,undefined,viewport),new FilterTileOrder(tiles,[0,0,0],viewport)]) {
    order.chooseNext(0);expect(order.indexAt(1)).toBe(1)
    // Selection is locked once speculation may have started.
    order.chooseNext(0,support);expect(order.indexAt(1)).toBe(1)
  }
  for(const barrier of [tile(1,1,{prefetch:true}),tile(6,1)]) {
    const order=new FilterTileOrder([tiles[0],barrier,tiles[2]],[0,0,0],viewport)
    order.chooseNext(0,support);expect(order.indexAt(1)).toBe(1)
  }
})

test('zoom, phase, dimensions, x and positive filter overlap all participate in selection', () => {
  const changes: Partial<RasterTile>[]=[{zoom:2},{phaseX:.25},{phaseY:.25},{width:513},{height:513},{x:511}]
  for(const change of changes){
    const tiles=[tile(0,1),tile(1,1),tile(0,0,change)],order=new FilterTileOrder(tiles,[0,0,0],viewport)
    order.chooseNext(0,support);expect(order.indexAt(1)).toBe(1)
  }
  const order=new FilterTileOrder([tile(0,0),tile(1,0),tile(0,3)],[0,0,0],viewport)
  order.chooseNext(0,{sourceScale:2,sourceRows:1000});expect(order.indexAt(1)).toBe(1)
  expect(validTileFillPriorities([0,1,2],3)).toBe(true)
  for(const hints of [[0,1], [0,1,3], [0,1,NaN], '012', [0,1,'2']])expect(validTileFillPriorities(hints,3)).toBe(false)
})

test('20 visible tiles remain a permutation, with each warmed column processed together', () => {
  const tiles=planTiles(viewport,1),order=new FilterTileOrder(tiles,tiles.map(()=>1),viewport),seen: RasterTile[]=[]
  for(let at=0;at<tiles.length;at++){seen.push(tiles[order.indexAt(at)]);order.chooseNext(at,support)}
  expect(seen).toHaveLength(20);expect(seen[0]).toBe(tiles[0]);expect(new Set(seen).size).toBe(20)
  const runs=seen.filter((t,i)=>i===0||t.x!==seen[i-1].x)
  expect(runs).toHaveLength(5)
  const reusedRows=seen.reduce((sum,t,i)=>i&&t.x===seen[i-1].x?sum+Math.max(0,3484-Math.abs(t.y-seen[i-1].y)*2):sum,0)
  expect(reusedRows).toBeGreaterThanOrEqual(31780)
})

test('speculative producers and consumers pair by original index through reorder, cached skips and cancellation', async () => {
  const tiles=[tile(0,1),tile(1,1),tile(0,2),tile(0,0)],order=new FilterTileOrder(tiles,[0,0,0,0],viewport)
  const ahead=new PrepareAhead<{index:number;tile:RasterTile}>(),seen:number[]=[]
  const compile=async(index:number)=>({index,tile:tiles[index]})
  for(let at=0;at<tiles.length;at++){
    const index=order.indexAt(at)
    if(at===2){await ahead.drain();seen.push(index);continue} // Certified final-tile hit.
    const prepared=await ahead.take(index)??await compile(index)
    expect(prepared.index).toBe(index);expect(prepared.tile).toBe(tiles[index]);seen.push(index)
    const plan=order.chooseNext(at,support)
    if(plan.index!==undefined){ahead.start(plan.index,()=>compile(plan.index));order.chooseNext(at,{sourceScale:1,sourceRows:1})}
  }
  expect(seen).toEqual([0,3,2,1]);expect(ahead.hits).toBe(1)
  ahead.start(99,async()=>{throw Error('PREVIEW_CANCELLED')});await ahead.drain()
  ahead.start(0,()=>compile(0));expect((await ahead.take(0))!.tile).toBe(tiles[0])
})

function compiledScene() {
  const rect={x:-100,y:-100,w:256,h:256},rows=rect.h*4,header=1+rows,curves=new Float32Array((header+rows*3)*4)
  curves.set([3,1,rect.w,rect.h])
  for(let row=0;row<rows;row++){curves.set([header+row*3,1,0,0],4+row*4);curves.set([0,rect.w,0,0],(header+row*3)*4)}
  const n={id:'image',rect,matrix:[1,0,0,1,0,0],inverse:[1,0,0,1,0,0],size:[256,256],opacity:1,blend:'normal',children:[],strokes:[],
    fill:{rect,count:3,first:0,sampleCount:4,rule:'nonzero',area:{first:0,count:curves.length/4}},
    fills:[{id:'p',kind:'image',image:'data:image/png;base64,eA==',visible:true,blend:'normal',opacity:1,color:'#000000'}],
    effects:[{kind:'blur',visible:true,radius:64}]}
  return {floatCompositing:true,integratedBlur:true,coherentSamples:true,extent:{x:0,y:0,w:8,h:8},view:{x:0,y:0,zoom:1},nodes:{image:n},curves} as unknown as GpuScene
}
test('ordering requires the actual large-image scene and exact full-sample interval proof',()=>{
  const scene=compiledScene(),current=tile(0,0)
  expect(compiledFilterColumnSupport(scene,current)).toEqual({sourceScale:1,sourceRows:138})
  for(const change of [
    (s:GpuScene)=>{s.coherentSamples=false},(s:GpuScene)=>{s.displayFilters=true},(s:GpuScene)=>{s.nodes.image.children=['x']},
    (s:GpuScene)=>{s.nodes.image.effects[0].radius=38},(s:GpuScene)=>{s.nodes.image.fills[0].opacity=.5},
    (s:GpuScene)=>{s.nodes.image.fills[0].blend='multiply'},(s:GpuScene)=>{s.nodes.image.previewSource=s.nodes.image},
    (s:GpuScene)=>{s.nodes.image.rect={x:1,y:1,w:2,h:2}},
    (s:GpuScene)=>{s.curves![4+(150*4+2)*4+1]=0},
  ]){const input=compiledScene();change(input);expect(compiledFilterColumnSupport(input,current)).toBeUndefined()}
})
