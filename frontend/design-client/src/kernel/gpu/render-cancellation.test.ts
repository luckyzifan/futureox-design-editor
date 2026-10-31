import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene, Texture } from './types'

function setup() {
  let current = true, fenced = false
  const live = new Set<Texture>(), events: string[] = []
  const driver = {
    name: 'webgpu', description: 'mock cancellation GPU', lost: false,
    drawCalls: 0, triangles: 0, scratchBytes: 0,
    begin: vi.fn(),
    create(width: number, height: number) {
      const texture = { width, height, bytes: width * height * 4, resource: {} } as Texture
      live.add(texture); return texture
    },
    destroy(texture: Texture) { events.push('destroy'); expect(fenced).toBe(true); live.delete(texture) },
    pass: vi.fn(), clear: vi.fn(), mask: vi.fn(),
    finish: vi.fn(async () => { events.push('finish'); return {} }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => {
      events.push('abort'); await Promise.resolve(); fenced = true; events.push('fence')
    }),
  } as unknown as Driver
  const renderer = new GpuRenderer(driver)
  const scene = {
    version: 7, width: 8, height: 8, extent: { x: 0, y: 0, w: 8, h: 8 },
    background: '#ffffff', transparent: false, grid: false,
    view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [],
  } as GpuScene
  return { renderer, driver, scene, events, live, isCurrent: () => current,
    cancel: () => { current = false }, resume: () => { current = true } }
}

test('already obsolete queued frame does not begin, abort or publish', async () => {
  const s = setup(); s.cancel()
  await expect(s.renderer.render(s.scene, false, true, s.isCurrent)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(s.driver.begin).not.toHaveBeenCalled()
  expect(s.driver.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
  expect(s.driver.finish).not.toHaveBeenCalled()
  s.resume()
  await s.renderer.render(s.scene, false, true, s.isCurrent)
  expect(s.driver.finish).toHaveBeenCalledOnce()
})

test('cancel at encoding yield fences submitted references before cleanup and never publishes a partial frame', async () => {
  const s = setup(), renderer = s.renderer as any
  // Frame-local parameter uploads must survive until the abort completion
  // boundary; previously displayed tiles belong to the driver.
  const displayed = s.driver.create(8, 8)
  vi.mocked(s.driver.pass).mockImplementationOnce(() => {
    const upload = s.driver.create(1, 1)
    renderer.coordinateMaps.add(upload); renderer.bytes += upload.bytes
  })
  vi.spyOn(renderer.encodeYield, 'checkpoint').mockImplementationOnce(() =>
    Promise.resolve().then(() => { s.events.push('camera-message'); s.cancel() }))
  await expect(s.renderer.render(s.scene, false, true, s.isCurrent)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(s.events).toEqual(['camera-message', 'abort', 'fence', 'destroy'])
  expect(s.driver.finish).not.toHaveBeenCalled()
  expect(s.live.has(displayed)).toBe(true)
  expect(renderer.busy.size).toBe(0)
  expect(renderer.coordinateMaps.size).toBe(0)
  expect(renderer.frameCurrent).toBeUndefined()
  // Quiet final view renders at the unchanged scene's exact dimensions.
  s.resume()
  await s.renderer.render(s.scene, false, true, s.isCurrent)
  expect(s.driver.finish).toHaveBeenCalledOnce()
  expect(vi.mocked(s.driver.finish).mock.calls[0].slice(2, 4)).toEqual([8, 8])
  expect(s.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce()
})

test('drivers without an abort contract keep completed-frame behavior', async () => {
  const s = setup(); delete s.driver.abortFrameAndReleaseFilterScratch; s.cancel()
  await s.renderer.render(s.scene, false, true, s.isCurrent)
  expect(s.driver.finish).toHaveBeenCalledOnce()
})

test('freshness is rechecked after asynchronous pipeline preparation', async () => {
  const s = setup()
  s.driver.prepareScene = vi.fn(async () => { await Promise.resolve(); s.cancel() })
  await expect(s.renderer.render(s.scene, false, true, s.isCurrent)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(s.driver.begin).not.toHaveBeenCalled()
  expect(s.driver.finish).not.toHaveBeenCalled()
  expect(s.driver.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
  expect((s.renderer as any).frameCurrent).toBeUndefined()
})

test('continued supersession admits control tasks and the quiet latest frame settles', async () => {
  const s = setup(), renderer = s.renderer as any
  let cameraMessages = 0
  for (let index = 0; index < 8; index++) {
    s.resume()
    vi.spyOn(renderer.encodeYield, 'checkpoint').mockImplementationOnce(() =>
      Promise.resolve().then(() => { cameraMessages++; s.cancel() }))
    await expect(s.renderer.render(s.scene, false, true, s.isCurrent)).rejects.toThrow('PREVIEW_CANCELLED')
  }
  expect(cameraMessages).toBe(8)
  expect(s.driver.finish).not.toHaveBeenCalled()
  s.resume()
  await s.renderer.render({ ...s.scene, view: { x: 7, y: 9, zoom: 2 } }, false, true, s.isCurrent)
  expect(s.driver.finish).toHaveBeenCalledOnce()
  expect(renderer.scene.view).toEqual({ x: 7, y: 9, zoom: 2 })
})

test('navigation queue progress allows cancellation before another raster submission',async()=>{
 const s=setup(),renderer=s.renderer as any
 s.driver.captureDisplay=true
 s.driver.yieldRasterQueue=vi.fn(async()=>{s.events.push('queue-progress');s.cancel()})
 vi.spyOn(renderer.encodeYield,'checkpoint').mockImplementationOnce(()=>Promise.resolve())
 await expect(s.renderer.render(s.scene,false,true,s.isCurrent,undefined,true)).rejects.toThrow('PREVIEW_CANCELLED')
 expect(s.driver.yieldRasterQueue).toHaveBeenCalledOnce();expect(s.driver.finish).not.toHaveBeenCalled()
 expect(s.events).toContain('fence');expect(renderer.displayBackpressure).toBe(false)
 s.resume();await s.renderer.render(s.scene,false,true,s.isCurrent)
 expect(s.driver.finish).toHaveBeenCalledOnce();expect(s.driver.yieldRasterQueue).toHaveBeenCalledOnce()
})

test.each(['readback','hdr','software','unpresented'])('display scheduling cannot enter an independent %s render',async mode=>{
 const s=setup(),renderer=s.renderer as any;s.driver.captureDisplay=true
 Object.assign(s.driver,{hdr:mode==='hdr',yieldRasterQueue:vi.fn(async()=>{})})
 vi.spyOn(renderer.encodeYield,'checkpoint').mockImplementationOnce(()=>Promise.resolve())
 // Inspect the real render-owned policy without constructing an unrelated HDR
 // device. The complete render/abort path is exercised by the test above.
 vi.spyOn(renderer,'renderAttempt').mockImplementation(async()=>{expect(renderer.displayBackpressure).toBe(false);return {}})
 await s.renderer.render({...s.scene,softwareRaster:mode==='software'},mode==='readback',mode!=='unpresented',s.isCurrent,undefined,true)
 expect(s.driver.yieldRasterQueue).not.toHaveBeenCalled()
})
