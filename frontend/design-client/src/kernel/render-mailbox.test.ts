import { expect, test } from 'vitest'
import { RenderMailbox } from './render-mailbox'

test('camera changes preserve active pixels, skip superseded queues and run the newest request', async () => {
  const mailbox = new RenderMailbox(), calls: string[] = []
  let camera = 1, release!: () => void
  const first = mailbox.run(() => camera === 1, async () => {
    calls.push('first'); await new Promise<void>(resolve => { release = resolve }); return 'pixels'
  })
  await Promise.resolve()
  camera = 2
  const obsolete = mailbox.run(() => camera === 2, async () => { calls.push('obsolete') })
  const rejection = expect(obsolete).rejects.toThrow('PREVIEW_CANCELLED')
  camera = 3
  const newest = mailbox.run(() => camera === 3, async () => { calls.push('newest') })
  release()
  expect(await first).toBe('pixels')
  await rejection; await newest
  expect(calls).toEqual(['first', 'newest'])
})

test('failed work does not poison subsequent rendering', async () => {
  const mailbox = new RenderMailbox()
  await expect(mailbox.run(() => true, async () => { throw Error('lost') })).rejects.toThrow('lost')
  expect(await mailbox.run(() => true, async () => 42)).toBe(42)
})

test('a stalled raster retains only the newest waiting camera, not a promise chain per input frame', async () => {
  const mailbox = new RenderMailbox(), calls: number[] = []
  let camera = 0, release!: () => void, pruned = 0
  const active = mailbox.run(() => camera === 0, async () => {
    calls.push(0); await new Promise<void>(resolve => { release = resolve })
  })
  await Promise.resolve()
  const waiting: Promise<unknown>[] = []
  for (let value = 1; value <= 2000; value++) {
    camera = value
    waiting.push(mailbox.run(() => camera === value, async () => { calls.push(value) }).catch(error => {
      expect(String(error)).toContain('PREVIEW_CANCELLED'); pruned++
    }))
  }
  await Promise.resolve(); await Promise.resolve()
  // Obsolete closures are released while the active native call is still
  // blocked, instead of all surviving until the promise chain is drained.
  expect(pruned).toBe(1999)
  expect(calls).toEqual([0])
  release(); await active; await Promise.all(waiting)
  expect(calls).toEqual([0, 2000])
})

test('separate still-current jobs retain FIFO order without being coalesced away', async () => {
  const mailbox = new RenderMailbox(), calls: number[] = []
  const work = [1, 2, 3].map(value => mailbox.run(() => true, async () => { calls.push(value); return value }))
  expect(await Promise.all(work)).toEqual([1, 2, 3])
  expect(calls).toEqual([1, 2, 3])
})
