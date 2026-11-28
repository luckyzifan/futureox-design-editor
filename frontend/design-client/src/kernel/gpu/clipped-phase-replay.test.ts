import { expect, test, vi } from 'vitest'
import { blank, node, type Matrix } from '../../model'
import { ClippedPhaseReplay } from './clipped-phase-replay'
import type { Driver, GpuScene } from './types'

const pose = (x: number, y = 10): Matrix => [1, 0, 0, 1, x, y]
function fixture(stationaryInsideView = false) {
  const doc = blank(), board = node('frame', 10, 10, 100, 80), stationary = stationaryInsideView ? node('frame', 35, 94, 40, 20) : node('frame', 124, 10, 120, 80)
  for (const root of [board, stationary]) {
    root.clip = true
    root.blend = 'normal'
    doc.nodes[root.id] = root
  }
  const fill = board.fills[0]
  if (fill.kind !== 'solid') throw Error('Expected an opaque solid board')
  fill.color = 'color(srgb 1 1 1)'
  const page = doc.pages[0]
  page.children = [board.id, stationary.id]
  const scene = { output: { x: 0, y: 0, w: 160, h: 160 }, view: { x: 0, y: 0, zoom: 1.6 },
    roots: page.children, nodes: { [board.id]: {} } } as GpuScene
  const viewport = { view: { x: 0, y: 0, zoom: .8 }, width: 80, height: 80, dpr: 2 }
  const controller = new AbortController()
  const device = {
    saveClippedBackground: vi.fn<NonNullable<Driver['saveClippedBackground']>>(() => 11),
    saveClippedRegion: vi.fn<NonNullable<Driver['saveClippedRegion']>>(() => 12),
    copyClippedPose: vi.fn<NonNullable<Driver['copyClippedPose']>>(() => 13),
    releasePresented: vi.fn(),
  }
  const atlas = ClippedPhaseReplay.create(device as unknown as Driver, scene, doc, page.id, board.id,
    { ...viewport.view, width: viewport.width, height: viewport.height, dpr: viewport.dpr }, controller.signal)!
  return { atlas, controller, device, viewport }
}

test('same-phase motion copies only source texels that the earlier viewport actually contains', () => {
  const { atlas, device, viewport } = fixture()
  atlas.record(5, pose(10))
  expect(device.saveClippedBackground).toHaveBeenCalledOnce()
  expect(device.saveClippedRegion).toHaveBeenCalledWith(5, { x: 14, y: 14, w: 146, h: 132 })
  expect(atlas.find(pose(11))).toBeUndefined() // A different coverage phase.
  expect(atlas.find(pose(5))).toBeUndefined() // A newly revealed right edge.
  expect(atlas.find(pose(25))).toBeDefined() // An overlap entirely outside the viewport cannot affect this copy.
  const match = atlas.find(pose(15, 15))!
  expect(atlas.show(match)).toBe(13)
  expect(device.copyClippedPose).toHaveBeenCalledWith(11, 12, { x: 0, y: 0, w: 138, h: 132 }, { x: 22, y: 22 })
  expect(atlas.sameViewport(viewport)).toBe(true)
  expect(atlas.sameViewport({ ...viewport, view: { ...viewport.view, x: .5 } })).toBe(false)
})

test('a stationary frame inside the destination rejects reuse before it can occlude the board', () => {
  const { atlas } = fixture(true)
  atlas.record(5, pose(10))
  expect(atlas.find(pose(15))).toBeDefined()
  expect(atlas.find(pose(15, 15))).toBeUndefined()
})

test('cache pressure and cancellation preserve the original renderer and release private textures', () => {
  const { atlas, device, controller } = fixture()
  device.saveClippedRegion.mockReturnValueOnce(undefined)
  atlas.record(5, pose(10))
  expect(atlas.find(pose(15))).toBeUndefined()
  atlas.record(5, pose(10))
  const match = atlas.find(pose(15))!
  device.copyClippedPose.mockReturnValueOnce(undefined)
  expect(atlas.show(match)).toBeUndefined()
  controller.abort()
  expect(device.releasePresented).toHaveBeenCalledWith([11, 12])
  expect(atlas.show(match)).toBeUndefined()
  expect(atlas.find(pose(15))).toBeUndefined()
})

test('a miss can capture a wider portion of the same phase without extending the computed viewport', () => {
  const { atlas } = fixture()
  atlas.record(5, pose(10))
  const anchor = atlas.representative(pose(40, 15))
  expect(anchor).toEqual(pose(5, 15))
  atlas.record(5, anchor!)
  expect(atlas.find(pose(40, 15))).toBeDefined()
  expect(atlas.find(pose(15, 15))).toBeDefined()
})

test('same-phase replay accepts fractional authored origins on whole physical shifts', () => {
  const { atlas, device } = fixture()
  // A real drag pose carries a fractional document origin. At this 1.6 device
  // scale only a 1.25-unit step is a whole 2-pixel shift; 0.5 units is 0.8.
  atlas.record(5, pose(10.25))
  expect(device.saveClippedRegion).toHaveBeenCalledOnce()
  expect(atlas.find(pose(10.75))).toBeUndefined() // 0.8 physical pixels: another phase.
  expect(atlas.find(pose(12.5))).toBeUndefined() // 3.6 physical pixels: another phase.
  const match = atlas.find(pose(11.5))
  expect(match).toBeDefined()
  expect(atlas.show(match!)).toBe(13)
  expect(device.copyClippedPose).toHaveBeenCalledOnce()
  // 3.75 units is 6.000000000000001 physical pixels: whole within the lattice
  // tolerance, so the copy stays on the same texels instead of resampling.
  const noisy = atlas.find(pose(14))
  expect(noisy).toBeDefined()
  expect(atlas.show(noisy!)).toBe(13)
})
