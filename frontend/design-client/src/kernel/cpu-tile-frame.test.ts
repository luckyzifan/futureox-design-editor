import { expect, test } from 'vitest'
import { cpuDisplayPressure, cpuTileBlitOrigin, cpuTileFrameOptions, sampleCpuTile } from './cpu-tile-frame'

test('cpu tile camera shifts the gpu viewport origin to device zero', () => {
  const frame = cpuTileFrameOptions(
    { pageId: 'p', width: 1600, height: 900, view: { x: 10.4, y: -3.2, zoom: 0.5 }, rasterProfile: 'analytic', grid: false },
    { x: 511, y: -1, width: 514, height: 514, zoom: 0.5 },
  )
  expect(frame.width).toBe(514)
  expect(frame.height).toBe(514)
  expect(frame.view).toEqual({ x: 10.4 - (511 + 10), y: -3.2 - (-1 + -4), zoom: 0.5 })
  expect(frame.gpuViewport).toBeUndefined()
  expect(frame.pageId).toBe('p')
  expect(frame.rasterProfile).toBe('analytic')
})

test('pressure errors are the only cpu tile failures that stay on screen', () => {
  expect(cpuDisplayPressure(Error('Compositing memory budget exceeded'))).toBe(true)
  expect(cpuDisplayPressure(Error('Layer surface exceeds 16 million pixels'))).toBe(true)
  expect(cpuDisplayPressure('Gaussian sigma must be in 0..1')).toBe(true)
  expect(cpuDisplayPressure(Error('Page not found'))).toBe(false)

})

test('CPU previews sample the same world origin and keep a separate exact-density receipt',async()=>{
  const frame={pageId:'p',view:{x:13.25,y:-9.5,zoom:3},width:17,height:13}
  const calls: (typeof frame)[]=[]
  const result=await sampleCpuTile(frame,async options=>{
    calls.push(options)
    if (calls.length===1) throw Error('Compositing memory budget exceeded')
    return new Uint8Array(options.width*options.height*4)
  },()=>true,true)
  expect(calls[1]).toMatchObject({width:9,height:7,view:{x:6.625,y:-4.75,zoom:1.5}})
  expect(result.divisor).toBe(2)
  const reject=async()=>{throw Error('Compositing memory budget exceeded')}
  await expect(sampleCpuTile(frame,reject,()=>true,false)).rejects.toThrow(/budget/)
  expect(await sampleCpuTile(frame,reject,()=>true,true)).toMatchObject({divisor:0,bytes:new Uint8Array(0)})
})

test('adjacent cpu tile blits do not round open a pasteboard seam', () => {
  const width = 514
  const left = cpuTileBlitOrigin(10.4, -3.2)
  const right = cpuTileBlitOrigin(524.6, -3.2)
  expect(left.x + width).toBeGreaterThanOrEqual(right.x)
  expect(cpuTileBlitOrigin(10.6, 4.8)).toEqual({ x: 10, y: 4 })
})
