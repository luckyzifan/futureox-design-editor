import { describe, expect, it } from 'vitest'
import { PipelineRegistry } from './pipeline-registry'
describe('device pipeline admission', () => {
  it('compiles only demanded programs and shares in-flight requests', async () => {
    const registry = new PipelineRegistry(); let count = 0, release!: () => void
    registry.register('visible', () => new Promise<void>(resolve => { count++; release = resolve }))
    registry.register('offscreen', async () => { throw Error('should not compile') })
    const first = registry.prepare(['visible', 'visible']), second = registry.prepare(['visible'])
    expect(count).toBe(1); release(); await Promise.all([first, second])
    await registry.prepare(['visible']); expect(registry.ready).toBe(1)
  })
  it('holds failure within this device and drains siblings before reporting it', async () => {
    const registry = new PipelineRegistry(); let count = 0, finished = false
    registry.register('bad', async () => { count++; throw Error('compile failed') })
    registry.register('sibling', async () => { await Promise.resolve(); finished = true })
    await expect(registry.prepare(['bad', 'sibling'])).rejects.toThrow('compile failed')
    expect(finished).toBe(true)
    await expect(registry.prepare(['bad'])).rejects.toThrow('compile failed')
    expect(count).toBe(1)
    const replacement = new PipelineRegistry(); replacement.register('bad', async () => {})
    await replacement.prepare(['bad']); expect(replacement.ready).toBe(1)
  })
})
