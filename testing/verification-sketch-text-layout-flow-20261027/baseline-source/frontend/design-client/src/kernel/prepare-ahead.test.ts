import { expect, test } from 'vitest'
import { PrepareAhead } from './prepare-ahead'

test('one preparation starts during GPU work and only the matching tile consumes it', async () => {
  const queue = new PrepareAhead<number>(), events: string[] = []
  let finish!: (value:number)=>void
  queue.start(1,()=>{events.push('cpu');return new Promise(resolve=>{finish=resolve})})
  queue.start(2,async()=>{throw Error('must not schedule an extra packet')})
  events.push('gpu'); await Promise.resolve()
  expect(events).toEqual(['gpu','cpu'])
  expect(await queue.take(0)).toBeUndefined()
  finish(42);expect(await queue.take(1)).toBe(42)
  expect(queue.starts).toBe(1);expect(queue.hits).toBe(1)
})
test('speculative failure is deferred, and cancellation drains it without poisoning the next plan',async()=>{
  const queue=new PrepareAhead<number>()
  queue.start(1,async()=>{throw Error('budget')})
  await expect(queue.take(1)).rejects.toThrow('budget')
  queue.start(2,async()=>{throw Error('cancelled packet')});await queue.drain()
  queue.start(3,async()=>7);expect(await queue.take(3)).toBe(7)
})
