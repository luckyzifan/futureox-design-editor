// Actual renderAttempt forwards existing render-call booleans to prepareScene.
// This recording transport proves intent routing, not pixels or GPU execution.
import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, GpuScene, Texture } from './types'

for (const managed of [true, false]) test.each([[false, true, true], [true, true, false], [true, false, false], [false, false, false]] as const)(
  `managed=${managed} render(readback=%s,present=%s) grants display intent=%s independently of bitmap/resident transport`, async (readback, present, expected) => {
    const create = (width: number, height: number) => ({ width, height, bytes: width * height * (managed ? 16 : 4), resource: {} }) as Texture
    const prepare = vi.fn(async (_scene: GpuScene, _displayOnly = false) => {})
    const finish = vi.fn(async () => ({ gpuTile: 1, linear: new Float32Array(16) }))
    let epoch = 0
    const driver = { name: 'webgpu', managed, captureDisplay: false, get resourceEpoch() { return epoch }, completedResourceEpoch: 0,
      prepareScene: prepare, begin() { epoch++ }, create, clear() {}, pass() {}, mask() {}, destroy() {},
      finish, stats: () => ({}) } as unknown as Driver
    const renderer = new GpuRenderer(driver)
    const scene: GpuScene = { version: 8, width: 2, height: 2, extent: { x: 0, y: 0, w: 2, h: 2 },
      output: { x: 0, y: 0, w: 2, h: 2 }, view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [], curves: [],
      background: '#ffffff', transparent: false, grid: false, floatCompositing: managed, coherentSamples: true }
    await renderer.render(scene, readback, present)
    expect(prepare).toHaveBeenCalledOnce(); expect(prepare.mock.calls[0][1]).toBe(expected)
    expect(driver.captureDisplay).toBe(false)
    expect(finish).toHaveBeenCalledOnce()
  })
