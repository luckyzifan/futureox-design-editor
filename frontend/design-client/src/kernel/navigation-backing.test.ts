// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { NavigationBacking, NAVIGATION_BACKING_BYTES } from './navigation-backing'
import { navigationOverview, nearOverviewTiles } from './navigation-overview'
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
