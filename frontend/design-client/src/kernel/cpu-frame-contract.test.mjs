import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCpuFrame } from './cpu-frame.ts'

for (const [name, options] of [
  ['integer analytic', { pageId: 'a', view: { x: 0, y: 0, zoom: 1 }, rasterProfile: 'analytic' }],
  ['page switch', { pageId: 'b', view: { x: 0, y: 0, zoom: 1 } }],
  ['fractional high zoom', { pageId: 'a', view: { x: .375, y: -120.5, zoom: 32 } }],
  ['animation and checkerboard', { pageId: 'a', animation: { time: 1 }, checkerboard: true }],
  ['managed document', { pageId: 'a', rasterProfile: 'figma', transparent: true }],
]) test(`${name}: routes original options to exact CPU renderer`, () => {
  const encoded = JSON.stringify(options), pixels = new Uint8Array([13, 29, 71, 128])
  let calls = 0
  const kernel = {
    color_settings() { throw Error('No heuristic color admission') },
    assemble_tiled_rgba() { throw Error('Uncertified reuse is forbidden') },
    render_rgba(value) { calls++; assert.equal(value, encoded); return pixels },
  }
  assert.equal(renderCpuFrame(kernel, encoded, { full: false, rects: [] }), pixels)
  assert.equal(calls, 1)
})
test('exact rendering failure is propagated, never hidden by cached pixels', () => {
  const error = Error('Compositing memory budget exceeded')
  const kernel = { render_rgba() { throw error }, assemble_tiled_rgba() { throw Error('unsafe fallback') } }
  assert.throws(() => renderCpuFrame(kernel, '{}', undefined), value => value === error)
})
