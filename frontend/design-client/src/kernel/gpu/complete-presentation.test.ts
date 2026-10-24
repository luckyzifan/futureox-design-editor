import { afterEach, expect, test, vi } from 'vitest'
import { descriptorPresenter } from '../descriptor-presenter.test-helper'
import type { ResidentFrame } from './resident-presenter'
afterEach(() => vi.unstubAllGlobals())
const item = (id: number, width: number, x = 0, layer = 0) => ({ active: true, layer, gutter: 0,
  tile: { key: String(id), gpuTile: id, serial: id, x, y: 0, width, height: 16, zoom: 1 } })
const frame = (items: ReturnType<typeof item>[], width = 16): ResidentFrame => ({
  view: { x: 0, y: 0, zoom: 1 }, width, height: 16, dpr: 1, items,
})

test('partial arrival never clears or acknowledges a new frame over a complete viewport', () => {
  const f = descriptorPresenter(() => {}), full = f.presenter.capture(16, 16), half = f.presenter.capture(8, 16)
  const original = frame([item(full.id, 16)]); f.presenter.draw(original)
  const epoch = f.queue.epoch, before = (f.presenter as any).backbuffer, bytes = f.presenter.residentBytes
  f.presenter.draw(frame([item(half.id, 8)]))
  expect(f.queue.epoch).toBe(epoch)
  expect((f.presenter as any).drawn).toBe(original)
  expect((f.presenter as any).backbuffer).toBe(before)
  expect(f.presenter.residentBytes).toBe(bytes)
  expect(f.reports.at(-1)).toMatchObject({ coverageDeferred: 1, coverageDeferredDraws: 1 })
  expect(f.reports.at(-1)?.presented).toBeUndefined()
})

test('incomplete resize preserves the actual backing dimensions; complete replacement advances them', () => {
  const f = descriptorPresenter(() => {}), first = f.presenter.capture(16, 16), next = f.presenter.capture(32, 16)
  f.presenter.draw(frame([item(first.id, 16)])); const before = (f.presenter as any).backbuffer, epoch = f.queue.epoch
  f.presenter.draw(frame([item(first.id, 16)], 32))
  expect(f.canvas.width).toBe(16); expect(f.queue.epoch).toBe(epoch)
  expect((f.presenter as any).backbuffer).toBe(before)
  const complete = frame([item(next.id, 32)], 32); f.presenter.draw(complete)
  expect(f.canvas.width).toBe(32); expect(f.queue.epoch).toBeGreaterThan(epoch)
  expect(f.reports.filter(row => row.presented)).toHaveLength(2)
  expect((f.presenter as any).drawn).toBe(complete)
})

test('one physical pixel hole blocks publication but a complete old backing permits fine replacement', () => {
  const f = descriptorPresenter(() => {}), full = f.presenter.capture(16, 16), left = f.presenter.capture(7, 16), right = f.presenter.capture(8, 16)
  f.presenter.draw(frame([item(full.id, 16)])); const epoch = f.queue.epoch
  f.presenter.draw(frame([item(left.id, 7), item(right.id, 8, 8)])); expect(f.queue.epoch).toBe(epoch)
  f.presenter.draw(frame([item(full.id, 16), item(left.id, 7, 0, 2), item(right.id, 8, 8, 2), item(999, 16, 0, 3)]))
  expect(f.queue.epoch).toBeGreaterThan(epoch)
  expect(f.reports.filter(row => row.presented)).toHaveLength(2)
  expect(f.reports.at(-1)?.presented).toBeDefined()
  expect(f.reports.at(-1)?.missingTextureCount).toBe(1)
})

test('explicit empty interaction clears remain permitted instead of retaining deleted content', () => {
  const f = descriptorPresenter(() => {}), full = f.presenter.capture(16, 16)
  f.presenter.draw(frame([item(full.id, 16)])); const epoch = f.queue.epoch
  f.presenter.draw({ ...frame([]), interaction: true, allowEmpty: true })
  expect(f.queue.epoch).toBe(epoch + 1)
  expect(f.reports.at(-1)).toMatchObject({ compositorDraws: 0, presented: { interaction: true } })
})

test('canvas reattachment copies the accepted backing even after its source tiles retire', () => {
  const f = descriptorPresenter(() => {}), full = f.presenter.capture(16, 16), half = f.presenter.capture(8, 16)
  const accepted = { ...frame([item(full.id, 16)]), presentationId: 'accepted' }
  f.presenter.draw(accepted)
  f.presenter.draw({ ...frame([item(half.id, 8)], 32), presentationId: 'pending' })
  f.presenter.release([full.id])
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({}) }
  const canvas = { width: 32, height: 16, getContext: () => context } as unknown as OffscreenCanvas
  const epoch = f.queue.epoch, reports = f.reports.filter(row => row.presented).length
  f.presenter.attachCanvas(canvas)
  expect(f.queue.epoch).toBe(epoch + 1)
  expect(canvas.width).toBe(16)
  expect((f.presenter as any).drawn).toBe(accepted)
  expect(f.reports.filter(row => row.presented)).toHaveLength(reports)
})
