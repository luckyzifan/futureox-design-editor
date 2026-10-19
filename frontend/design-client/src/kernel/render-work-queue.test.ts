import { expect, test } from 'vitest'
import { RenderWorkQueue } from './render-work-queue'
test('pointer work overtakes queued refinement without overlapping a running GPU job', async () => {
  const queue = new RenderWorkQueue(),
    events: string[] = []
  let release!: () => void
  const first = queue.run(async () => {
    events.push('tile start')
    await new Promise<void>((r) => (release = r))
    events.push('tile end')
  })
  const second = queue.run(async () => {
    events.push('prefetch')
  })
  const move = queue.run(async () => {
    events.push('move')
  }, 1)
  expect(events).toEqual(['tile start'])
  release()
  await Promise.all([first, second, move])
  expect(events).toEqual(['tile start', 'tile end', 'move', 'prefetch'])
})
test('a rejected render does not strand later work', async () => {
  const queue = new RenderWorkQueue()
  await expect(
    queue.run(async () => {
      throw Error('render failed')
    }),
  ).rejects.toThrow('render failed')
  let ran = false
  await queue.run(async () => {
    ran = true
  })
  expect(ran).toBe(true)
})

test('a completed tile yields to interaction but keeps document jobs ordered', async () => {
  const queue = new RenderWorkQueue(), events: string[] = []
  let release!: () => void
  const batch = queue.run(async () => {
    events.push('tile 1')
    await new Promise<void>(resolve => { release = resolve })
    await queue.yieldToHigherPriority(0)
    events.push('tile 2')
  })
  const edit = queue.run(async () => { events.push('next document') })
  const pose = queue.run(async () => { events.push('pose') }, 1)
  release()
  await Promise.all([batch, edit, pose])
  expect(events).toEqual(['tile 1', 'pose', 'tile 2', 'next document'])
})

test('a failed interrupt does not reject the suspended tile batch', async () => {
  const queue = new RenderWorkQueue()
  let release!: () => void, completed = false
  const batch = queue.run(async () => {
    await new Promise<void>(resolve => { release = resolve })
    await queue.yieldToHigherPriority(0)
    completed = true
  })
  const failed = queue.run(async () => { throw Error('pose failed') }, 1)
  const rejection = expect(failed).rejects.toThrow('pose failed')
  release()
  await Promise.all([batch, rejection])
  expect(completed).toBe(true)
})
