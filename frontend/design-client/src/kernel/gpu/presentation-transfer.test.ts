import {afterEach,expect,test,vi} from 'vitest'
import {descriptorPresenter} from '../descriptor-presenter.test-helper'
import {DISPLAY_TEXTURE_BUDGET} from './display-budget'
afterEach(()=>vi.unstubAllGlobals())
test('cross-device import charges both copies until the destination queue completes',async()=>{
  const f=descriptorPresenter(()=>{}),ticket=f.presenter.reserveBitmapImport(8,8)
  expect(f.presenter.payloadStats).toMatchObject({liveBytes:256,allocationReservedBytes:256})
  const bitmap={width:8,height:8,close:vi.fn()} as unknown as ImageBitmap
  expect(ticket.copy(bitmap)).toBe(ticket.id)
  expect(bitmap.close).toHaveBeenCalledOnce()
  expect(f.presenter.payloadStats).toMatchObject({liveBytes:256,allocationReservedBytes:0,retiringBytes:256})
  f.queue.completeThrough(f.queue.epoch)
  await vi.waitFor(()=>expect(f.presenter.payloadStats.retiringBytes).toBe(0))
  f.presenter.release([ticket.id]);await vi.waitFor(()=>expect(f.presenter.payloadStats.liveBytes+f.presenter.payloadStats.retiringBytes).toBe(0))
})
test('incomplete destination admission rolls back the transfer reservation before any texture allocation',()=>{
  const f=descriptorPresenter(()=>{}),ledger=(f.presenter as any).payload
  const hold=ledger.reserve(DISPLAY_TEXTURE_BUDGET-256),created=f.queue.resources.length
  expect(()=>f.presenter.reserveBitmapImport(8,8)).toThrow('budget exceeded')
  expect(f.queue.resources).toHaveLength(created)
  expect(f.presenter.payloadStats.allocationReservedBytes).toBe(DISPLAY_TEXTURE_BUDGET-256)
  ledger.cancel(hold)
})
test('failed or cancelled transfer keeps no unpublished destination or source reservation',async()=>{
  const f=descriptorPresenter(()=>{}),first=f.presenter.reserveBitmapImport(8,8)
  first.cancel();first.cancel()
  await vi.waitFor(()=>expect(f.presenter.payloadStats.liveBytes+f.presenter.payloadStats.retiringBytes+f.presenter.payloadStats.allocationReservedBytes).toBe(0))
  const second=f.presenter.reserveBitmapImport(8,8),bitmap={width:9,height:8,close:vi.fn()} as unknown as ImageBitmap
  expect(()=>second.copy(bitmap)).toThrow('dimensions changed');second.cancel()
  expect(bitmap.close).toHaveBeenCalledOnce()
  await vi.waitFor(()=>expect(f.presenter.payloadStats.liveBytes+f.presenter.payloadStats.retiringBytes+f.presenter.payloadStats.allocationReservedBytes).toBe(0))
})
test('sliced tile ownership waits for the presenter queue while another queue is already idle', async () => {
  const f = descriptorPresenter(() => {})
  const rasterIdle = Promise.resolve()
  const source = f.presenter.capture(8, 4)
  let owned = false
  const pending = f.presenter.slice(source.id, [{ x: 0, y: 0, w: 4, h: 4, rect: { x: 3, y: 1, w: 4, h: 4 } }])
    .then(ids => { owned = true; return ids })
  await rasterIdle
  await Promise.resolve()
  expect(owned).toBe(false)
  expect(f.queue.completed).toBeLessThan(f.queue.epoch)
  expect((source.texture as { destroyed?: boolean }).destroyed).toBe(false)
  f.queue.completeThrough(f.queue.epoch)
  const ids = await pending
  expect(owned).toBe(true)
  expect(ids).toHaveLength(1)
  const copy = f.queue.resources.find(resource => resource.width === 4 && resource.height === 4)
  expect(copy?.destroyed).toBe(false)
  f.presenter.release([source.id, ...(ids ?? [])])
})

test('a rejected slice releases only the copies it started', async () => {
  const f = descriptorPresenter(() => {})
  const source = f.presenter.capture(8, 4)
  await expect(f.presenter.slice(source.id, [{ x: 0, y: 0, w: 9, h: 4, rect: { x: 0, y: 0, w: 9, h: 4 } }])).rejects.toThrow('Invalid presented tile slice')
  expect(f.queue.resources.filter(resource => resource.width === 9)).toHaveLength(0)
  expect((source.texture as { destroyed?: boolean }).destroyed).toBe(false)
})

test('failure after queuing a copy cannot uncharge it before completion',async()=>{
  const f=descriptorPresenter(()=>{}),ticket=f.presenter.reserveBitmapImport(8,8)
  const bitmap={width:8,height:8,close(){throw Error('close failure')}} as unknown as ImageBitmap
  expect(()=>ticket.copy(bitmap)).toThrow('close failure');ticket.cancel()
  expect(f.presenter.payloadStats).toMatchObject({liveBytes:0,allocationReservedBytes:0,retiringBytes:512})
  f.queue.completeThrough(f.queue.epoch)
  await vi.waitFor(()=>expect(f.presenter.payloadStats.retiringBytes).toBe(0))
})
