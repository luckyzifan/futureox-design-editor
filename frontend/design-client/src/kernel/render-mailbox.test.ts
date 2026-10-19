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
