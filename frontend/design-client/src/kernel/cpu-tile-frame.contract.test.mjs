import assert from 'node:assert/strict'
import test from 'node:test'
import { cpuDisplayPressure, cpuTileFrameOptions, sampleCpuTile } from './cpu-tile-frame.ts'

test('cpu tile camera shifts the gpu viewport origin to device zero', () => {
  const frame = cpuTileFrameOptions(
    { pageId: 'p', width: 1600, height: 900, view: { x: 10.4, y: -3.2, zoom: 0.5 }, rasterProfile: 'analytic', grid: false },
    { x: 511, y: -1, width: 514, height: 514, zoom: 0.5 },
  )
  assert.equal(frame.width, 514)
  assert.equal(frame.height, 514)
  assert.deepEqual(frame.view, { x: 10.4 - (511 + 10), y: -3.2 - (-1 + -4), zoom: 0.5 })
  assert.equal(frame.gpuViewport, undefined)
  assert.equal(frame.pageId, 'p')
  assert.equal(frame.rasterProfile, 'analytic')
})

test('pressure errors are the only cpu tile failures that stay on screen', () => {
  assert.equal(cpuDisplayPressure(Error('Compositing memory budget exceeded')), true)
  assert.equal(cpuDisplayPressure(Error('Layer surface exceeds 16 million pixels')), true)
  assert.equal(cpuDisplayPressure('Gaussian sigma must be in 0..1'), true)
  assert.equal(cpuDisplayPressure(Error('Page not found')), false)

})
