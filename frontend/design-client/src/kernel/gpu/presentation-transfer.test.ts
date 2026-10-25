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
test('failure after queuing a copy cannot uncharge it before completion',async()=>{
  const f=descriptorPresenter(()=>{}),ticket=f.presenter.reserveBitmapImport(8,8)
  const bitmap={width:8,height:8,close(){throw Error('close failure')}} as unknown as ImageBitmap
  expect(()=>ticket.copy(bitmap)).toThrow('close failure');ticket.cancel()
  expect(f.presenter.payloadStats).toMatchObject({liveBytes:0,allocationReservedBytes:0,retiringBytes:512})
  f.queue.completeThrough(f.queue.epoch)
  await vi.waitFor(()=>expect(f.presenter.payloadStats.retiringBytes).toBe(0))
})
