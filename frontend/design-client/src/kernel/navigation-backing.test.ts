// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { NavigationBacking, NAVIGATION_BACKING_BYTES } from './navigation-backing'
import { navigationOverview, nearOverviewTiles, overviewWarmBatch } from './navigation-overview'
import { tilePlacementAtView } from './tile-preview'

afterEach(()=>vi.restoreAllMocks())

test('a single small page preview covers fractional and negative world coordinates including both gutters', () => {
  const bounds={x:-410.25,y:358.125,width:1922,height:1080}
  const plan=navigationOverview(bounds,2,751)!
  expect(plan.tiles).toHaveLength(1)
  const tile=plan.tiles[0]
  expect(tile.width*tile.height).toBeLessThanOrEqual(512*512)
  const place=tilePlacementAtView(tile,{x:0,y:0,zoom:tile.zoom})
  expect(place.left+1).toBeCloseTo(bounds.x*tile.zoom,9)
  expect(place.top+1).toBeCloseTo(bounds.y*tile.zoom,9)
  expect(tile.width-2).toBeGreaterThanOrEqual(bounds.width*tile.zoom)
})

test('a large page prepares bounded regional jobs and can seed a distant viewport before the page center', () => {
  const plan=navigationOverview({x:77,y:-271,width:15300,height:4420},2,20082)!
  expect(plan.tiles.length).toBeGreaterThan(1)
  expect(plan.tiles.length).toBeLessThanOrEqual(32)
  expect(plan.tiles.every(tile=>tile.width<=514 && tile.height<=514)).toBe(true)
  const near=nearOverviewTiles(plan.tiles,{x:0,y:0,zoom:1},800,600)
  expect(near[0].x).toBeLessThan(plan.tiles[0].x)
  const warm=overviewWarmBatch(plan.tiles,{x:0,y:0,zoom:1},800,600,tile=>tile!==near[0])
  expect(warm).toEqual(near.slice(1,3))
})

test('a late tile from another revision never paints the navigation backing', async () => {
  const drawImage=vi.fn(), clearRect=vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype as {getContext(kind:'2d'):CanvasRenderingContext2D|null},'getContext').mockReturnValue({drawImage,clearRect} as unknown as CanvasRenderingContext2D)
  const host=document.createElement('main'), backing=new NavigationBacking(host)
  const viewport={view:{x:0,y:0,zoom:1},width:128,height:128}
  const frame={...viewport,dpr:1,interaction:false,ids:[1],preview:false,gpuOverlay:true,navigationBackingBytes:NAVIGATION_BACKING_BYTES}
  const bounds={x:0,y:0,width:512,height:512}
  const tile={key:'a',x:0,y:0,zoom:1,width:130,height:130,gutter:1,gpuTile:1}
  let resolve!: () => void
  const deferred = new Promise<void>(done => {resolve=done})
  const bitmap={width:130,height:130} as ImageBitmap
  const refresh=vi.fn()
  backing.bind({})
  backing.capture(document.createElement('canvas'),frame)
  backing.warm(bounds,[tile],async (_id,use)=>{await deferred;use(bitmap)},refresh)
  backing.bind({})
  resolve();await deferred;await new Promise(resolve=>setTimeout(resolve,0))
  expect(drawImage).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledOnce()
  backing.capture(document.createElement('canvas'),frame)
  backing.warm(bounds,[tile],async (_id,use)=>{use(bitmap)},refresh)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(drawImage).toHaveBeenCalledOnce()
  backing.show({...frame,preview:true,previewGaps:[{x:0,y:0,width:16,height:16}]},viewport)
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('block')
  backing.bind({})
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('none')
  backing.dispose()
})

test('a complete source preview can replace a narrow view without reusing pixels from the previous revision', () => {
  const clearRect=vi.fn(), drawImage=vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype as {getContext(kind:'2d'):CanvasRenderingContext2D|null},'getContext')
    .mockReturnValue({clearRect,drawImage,save(){},restore(){}} as unknown as CanvasRenderingContext2D)
  const backing=new NavigationBacking(document.createElement('main'))
  const bounds={x:-10,y:20,width:512,height:512}, bitmap={width:256,height:256} as ImageBitmap
  const frame={view:{x:0,y:0,zoom:2},dpr:1,width:200,height:200,ids:[1],interaction:false,navigationBackingBytes:NAVIGATION_BACKING_BYTES}
  const first={},second={}
  backing.bind(first)
  expect(backing.seed(first,bounds,bitmap,0.5,frame)).toBe(true)
  backing.bind(second)
  expect(backing.completeFrame).toBeUndefined()
  expect(backing.seed(first,bounds,bitmap,0.5,frame)).toBe(false)
  expect(backing.seed(second,bounds,bitmap,0.5,frame)).toBe(true)
  expect(clearRect).toHaveBeenCalledTimes(2)
  expect(clearRect.mock.invocationCallOrder[1]).toBeLessThan(drawImage.mock.invocationCallOrder[1])
  expect(backing.completeFrame).toEqual({view:{x:10,y:-20,zoom:1},width:512,height:512})
  backing.dispose()
})

test('a sparse page admits newly painted strips at the requested zoom, but a crop alone cannot replace the last frame', async () => {
  vi.spyOn(HTMLCanvasElement.prototype as {getContext(kind:'2d'):CanvasRenderingContext2D|null},'getContext')
    .mockReturnValue({clearRect(){},drawImage(){}} as unknown as CanvasRenderingContext2D)
  const cache=new NavigationBacking(document.createElement('main'))
  const bounds={x:0,y:0,width:400,height:200}, target={view:{x:0,y:0,zoom:1},width:200,height:100}
  const previous={...target,view:{x:0,y:0,zoom:2},dpr:1,interaction:false,ids:[1],navigationBackingBytes:NAVIGATION_BACKING_BYTES}
  const next={...previous,...target,preview:true,previewGaps:[{x:150,y:0,width:50,height:100}]}
  cache.bind({})
  cache.capture(document.createElement('canvas'),{...previous,gpuOverlay:true})
  expect(cache.canAdvance(previous,next,target,bounds)).toBe(false)
  const tile={key:'region',x:99,y:-1,width:52,height:102,gutter:1,zoom:1,gpuTile:2}
  cache.warm(bounds,[tile],async (_id,use)=>use({width:52,height:102} as ImageBitmap),()=>{})
  await Promise.resolve()
  expect(cache.coversPage(next,target,bounds)).toBe(false)
  expect(cache.canAdvance(previous,next,target,bounds)).toBe(true)
  expect(cache.canAdvance(previous,{...next,previewGaps:[{x:0,y:0,width:200,height:100}]},target,bounds)).toBe(false)
  cache.dispose()
})
