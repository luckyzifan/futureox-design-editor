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

for (const budget of [1, 4]) test(`tile checkpoint returns after ${budget} continuous interaction arrivals`, async () => {
  const queue = new RenderWorkQueue(), events: string[] = [], jobs: Promise<void>[] = []
  let release!: () => void, stop = false, active = 0, maximum = 0
  const enqueue = (n: number) => jobs.push(queue.run(async () => {
    maximum = Math.max(maximum, ++active)
    events.push(`pose ${n}`)
    await Promise.resolve()
    if (!stop) enqueue(n + 1)
    active--
  }, 1))
  const batch = queue.run(async () => {
    await new Promise<void>(resolve => { release = resolve })
    await queue.yieldToHigherPriority(0, budget)
    events.push('resume canvas'); stop = true
  })
  enqueue(1); release(); await batch
  await Promise.all(jobs)
  expect(events.indexOf('resume canvas')).toBe(budget)
  expect(maximum).toBe(1)
  expect(events.at(-1)).toBe(`pose ${budget + 1}`)
})

test('bounded interruption preserves reliable edits and export while obsolete pixels cancel themselves', async () => {
  const queue = new RenderWorkQueue(), events: string[] = []
  let release!: () => void, revision = 0, superseded = false
  const first = queue.run(async () => {
    revision = 1
    await new Promise<void>(resolve => { release = resolve })
    await queue.yieldToHigherPriority(0, 1)
    expect(revision).toBe(1)
    events.push('canvas resumes')
  })
  const obsolete = queue.run(async () => {
    expect(revision).toBe(1); revision = 2; events.push('mutation 2')
    if (superseded) return
    events.push('obsolete raster')
  })
  const exact = queue.run(async () => { expect(revision).toBe(2); events.push('export 2') })
  const pose = queue.run(async () => { superseded = true; events.push('pose') }, 1)
  release(); await Promise.all([first, obsolete, exact, pose])
  expect(events).toEqual(['pose', 'canvas resumes', 'mutation 2', 'export 2'])
})

test('bounded checkpoint does not grant ownership before a submitted frame fence completes', async () => {
  const queue = new RenderWorkQueue(), events: string[] = []
  let fence!: () => void, resourceEpoch = 1, completedResourceEpoch = 0, config = 'canvas'
  const canvas = queue.run(async () => {
    events.push('submit canvas')
    await new Promise<void>(resolve => { fence = resolve })
    completedResourceEpoch = resourceEpoch
    events.push('complete canvas')
    await queue.yieldToHigherPriority(0, 1)
    expect(config).toBe('interaction')
    // The caller, not the queue, restores/revalidates the driver and lane.
    config = 'canvas'; events.push('restore canvas')
  })
  const pose = queue.run(async () => {
    expect(completedResourceEpoch).toBe(resourceEpoch)
    config = 'interaction'; resourceEpoch++; events.push('pose')
  }, 1)
  await Promise.resolve(); expect(events).toEqual(['submit canvas'])
  fence(); await Promise.all([canvas, pose])
  expect(events).toEqual(['submit canvas', 'complete canvas', 'pose', 'restore canvas'])
})

test('unbounded commit barrier retains its existing drain semantics', async () => {
  const queue = new RenderWorkQueue(), events: string[] = [], jobs: Promise<void>[] = []
  let release!: () => void
  const batch = queue.run(async () => {
    await new Promise<void>(resolve => { release = resolve })
    await queue.yieldToHigherPriority(0); events.push('commit')
  })
  const enqueue = (n: number) => jobs.push(queue.run(async () => {
    events.push(`pose ${n}`); if (n < 6) enqueue(n + 1)
  }, 1))
  enqueue(1); release(); await batch; await Promise.all(jobs)
  expect(events).toEqual(['pose 1', 'pose 2', 'pose 3', 'pose 4', 'pose 5', 'pose 6', 'commit'])
})

test('production checkpoint remains after tile transfer and restores only a current lane; commit barrier stays unbounded', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./render-worker.ts', import.meta.url), 'utf8')
  const checkpoint = source.indexOf("await queue.yieldToHigherPriority(channel === 'interaction' ? 1 : 0, GPU_PRIORITY_BURST)")
  expect(checkpoint).toBeGreaterThan(0)
  const delivered = source.lastIndexOf('undelivered = undefined // Ownership transfers only after successful delivery.', checkpoint)
  expect(delivered).toBeGreaterThan(source.lastIndexOf('self.postMessage(', checkpoint))
  expect(source.slice(delivered, checkpoint)).toContain('await yieldPreviewTask()')
  const restoration = source.indexOf('selectLane(channel)', checkpoint)
  const canceled = source.indexOf("throw new Error('PREVIEW_CANCELLED')", checkpoint)
  expect(canceled).toBeLessThan(restoration)
  const configuration = source.indexOf('if (settingsJson !== colorKey', restoration)
  expect(configuration).toBeGreaterThan(restoration)
  expect(source.slice(configuration, configuration + 240)).toContain('invalidateTileCache()')
  expect(source.match(/await queue\.yieldToHigherPriority\(0\)/g)).toHaveLength(1)
  expect(source.match(/GPU_PRIORITY_BURST\)/g)).toHaveLength(1)
})
