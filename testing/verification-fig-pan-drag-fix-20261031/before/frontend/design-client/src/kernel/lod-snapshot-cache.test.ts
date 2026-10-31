import { expect, test } from 'vitest'
import { LodSnapshotCache } from './lod-snapshot-cache'

// Canvas ownership model only: actual browser drawing and rapid document edits
// are exercised by check-workspace-ui. Resizing clears the recorded pixels just
// as it clears a DOM canvas, making premature resource reclamation observable.
class Canvas {
  private w = 0
  private h = 0
  pixels = ''
  get width() { return this.w }
  set width(value: number) { this.w = value; this.pixels = '' }
  get height() { return this.h }
  set height(value: number) { this.h = value; this.pixels = '' }
  getContext() {
    return {
      drawImage: (source: Canvas) => {
        if (!source.width || !source.height) throw new Error('Image source is detached')
        this.pixels = source.pixels
      },
    }
  }
}
const domCanvas = (canvas: Canvas) => canvas as unknown as HTMLCanvasElement
const modelCanvas = (canvas: HTMLCanvasElement) => canvas as unknown as Canvas
function source(pixels: string) {
  const canvas = new Canvas()
  canvas.width = 2; canvas.height = 2; canvas.pixels = pixels
  return canvas
}
function cache(bytes = 32) {
  let allocations = 0
  const owner = new LodSnapshotCache(bytes, () => { allocations++; return domCanvas(new Canvas()) })
  owner.beginRevision(1)
  return { owner, allocations: () => allocations }
}

test('a producer is copied synchronously and later producer painting cannot alter a borrowed snapshot', () => {
  const { owner } = cache(), producer = source('first')
  expect(owner.publish(1, 'tile', domCanvas(producer))).toBe(true)
  const borrowed = modelCanvas(owner.borrow(1, 'tile')!)
  producer.width = 8; producer.pixels = 'later'
  expect(borrowed.width).toBe(2)
  expect(borrowed.pixels).toBe('first')
})

test('replacing and clearing cache ownership cannot invalidate a render-selected source before its effect draws', () => {
  const { owner } = cache()
  owner.publish(1, 'tile', domCanvas(source('old')))
  const renderSelected = owner.borrow(1, 'tile')!
  owner.publish(1, 'tile', domCanvas(source('replacement')))
  const replacement = owner.borrow(1, 'tile')!
  owner.clear()
  // Simulate React's passive drawing effect after both replacement and cleanup.
  const effectCanvas = new Canvas()
  effectCanvas.getContext().drawImage(modelCanvas(renderSelected))
  expect(effectCanvas.pixels).toBe('old')
  effectCanvas.getContext().drawImage(modelCanvas(replacement))
  expect(effectCanvas.pixels).toBe('replacement')
  expect(owner.bytes).toBe(0)
  expect(owner.size).toBe(0)
})

test('revision changes reject late publication and never lend old-document pixels to the new document', () => {
  const { owner, allocations } = cache()
  owner.publish(1, 'tile', domCanvas(source('old-document')))
  const oldBorrower = owner.borrow(1, 'tile')!
  owner.beginRevision(2)
  expect(owner.borrow(2, 'tile')).toBeUndefined()
  expect(owner.borrow(1, 'tile')).toBeUndefined()
  expect(owner.publish(1, 'tile', domCanvas(source('late-old-document')))).toBe(false)
  expect(allocations()).toBe(1)
  owner.publish(2, 'tile', domCanvas(source('new-document')))
  expect(modelCanvas(owner.borrow(2, 'tile')!).pixels).toBe('new-document')
  expect(modelCanvas(oldBorrower).pixels).toBe('old-document')
  expect(owner.bytes).toBe(16)
})

test('LRU eviction respects the byte ceiling while a mounted borrower retains a valid retired source', () => {
  const { owner } = cache()
  owner.publish(1, 'a', domCanvas(source('a')))
  owner.publish(1, 'b', domCanvas(source('b')))
  const retired = owner.borrow(1, 'b')!
  owner.borrow(1, 'a')
  owner.publish(1, 'c', domCanvas(source('c')))
  expect(owner.bytes).toBe(32)
  expect(owner.size).toBe(2)
  expect(owner.borrow(1, 'b')).toBeUndefined()
  expect(owner.borrow(1, 'a')).toBeDefined()
  const effectCanvas = new Canvas()
  effectCanvas.getContext().drawImage(modelCanvas(retired))
  expect(effectCanvas.pixels).toBe('b')
})

test('oversized and unowned sources are rejected before allocation and a cleared owner cannot accept late work', () => {
  const { owner, allocations } = cache(8)
  expect(owner.publish(1, 'tile', domCanvas(source('large')))).toBe(false)
  owner.clear()
  expect(owner.publish(1, 'tile', domCanvas(source('late')))).toBe(false)
  expect(allocations()).toBe(0)
  expect(owner.bytes).toBe(0)
})
