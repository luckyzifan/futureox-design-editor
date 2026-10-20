import { afterEach, expect, test, vi } from 'vitest'
import { PreparationChannel } from './preparation-channel'
import { connectNativePreparation } from './native-preparation'
import { sanitizeFields } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(() => vi.useRealTimers())
function fixture(enabled = true) {
 const rows: any[] = [], sent: any[] = []
 const port: any = {start(){},close(){},postMessage(x: any){sent.push(x)}}
 const client = new PreparationChannel(port, {enabled:()=>enabled,owner:()=>954,record:(_e,f)=>rows.push(f)})
 return {client,port,rows,sent,reply:(data:any)=>port.onmessage({data})}
}
test('progress and malformed progress never release active fence; late cancellation stays correlated', async()=>{
 const f=fixture(), abort=new AbortController()
 const first=f.client.request('canvas','compile_gpu_packet',[],abort.signal).catch(e=>e.message)
 const second=f.client.request('canvas','load_document',['private-document'])
 abort.abort();expect(await first).toBe('PREVIEW_CANCELLED')
 for(const progress of [{backendCode:2,boundaryCode:5,boundaryDurationMs:1},{backendCode:999,boundaryCode:2},null])f.reply({id:1,progress})
 expect(f.sent).toHaveLength(1)
 expect(f.rows.find(r=>r.phase===5)).toMatchObject({requestId:954,preparationId:1,superseded:true,backendCode:2,boundaryCode:5})
 f.reply({id:1,value:new Uint8Array()});expect(f.sent).toHaveLength(2)
 f.reply({id:1,value:'duplicate terminal'});expect(f.sent).toHaveLength(2)
 f.reply({id:2,value:'ok'});expect((await second).value).toBe('ok');f.client.close()
 expect(JSON.stringify(f.rows)).not.toContain('private-document')
})
test('watchdog is bounded, never dispatches mutation, and clears on completion/close/send failure',async()=>{
 vi.useFakeTimers()
 const f=fixture();const first=f.client.request('canvas','compile_gpu_packet').catch(()=>{})
 const next=f.client.request('canvas','load_document',['document']).catch(()=>{})
 vi.advanceTimersByTime(300000)
 expect(f.rows.filter(r=>r.phase===6)).toHaveLength(8);expect(f.sent).toHaveLength(1);expect(vi.getTimerCount()).toBe(0)
 f.reply({id:1,value:1});expect(f.sent).toHaveLength(2);expect(vi.getTimerCount()).toBe(1)
 f.reply({id:2,value:2});expect(vi.getTimerCount()).toBe(0);await Promise.all([first,next]);f.client.close()
 const g=fixture();const pending=g.client.request('canvas','stats').catch(()=>{});g.client.close();await pending;expect(vi.getTimerCount()).toBe(0)
 const h=fixture();h.port.postMessage=()=>{throw Error('failed')};await expect(h.client.request('canvas','stats')).rejects.toThrow('failed');expect(vi.getTimerCount()).toBe(0);h.client.close()
 const off=fixture(false);const work=off.client.request('canvas','stats').catch(()=>{});expect(vi.getTimerCount()).toBe(0);expect(off.sent[0]).not.toHaveProperty('diagnostics');off.client.close();await work
})
test('all new numeric diagnostic fields reject invalid types and bounds',()=>{
 for(const field of ['backendCode','boundaryCode','boundaryDurationMs'])for(const value of [-1,NaN,Infinity,'1',{},true,120001])expect(sanitizeFields({[field]:value})).toEqual({})
 expect(sanitizeFields({backendCode:1.1,boundaryCode:2.2})).toEqual({})
 expect(sanitizeFields({backendCode:2,boundaryCode:16,boundaryDurationMs:1.25})).toEqual({backendCode:2,boundaryCode:16,boundaryDurationMs:1.25})
})
test('native bridge reports actual IPC boundaries without claiming Rust execution started',async()=>{
 const pair=new MessageChannel(),rows:any[]=[]
 let resolve!:(v:any)=>void
 const bridge={open:async()=>'owner',close:async()=>{},request:vi.fn(async(_session: string, _request: unknown)=>new Promise<any>(r=>{resolve=r}))}
 const connection=connectNativePreparation(bridge,pair.port1)
 const channel=new PreparationChannel(pair.port2,{enabled:()=>true,owner:()=>954,record:(_e,r)=>rows.push(r)})
 try{
 const result=channel.request('canvas','compile_gpu_packet',['secret'])
 await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
 await vi.waitFor(()=>expect(rows.some(r=>r.phase===5&&r.boundaryCode===5)).toBe(true))
 expect(bridge.request.mock.calls[0][1]).toMatchObject({diagnostics:{requestId:954,preparationId:1}})
 expect(rows.some(r=>r.phase===5&&[2,3].includes(r.boundaryCode))).toBe(false)
 resolve({id:99,value:new Uint8Array([1,2])});expect((await result).value).toEqual(new Uint8Array([1,2]))
 expect(rows.filter(r=>r.phase===5).map(r=>r.boundaryCode)).toEqual([1,5,6]);expect(rows.at(-1).phase).toBe(4)
 expect(JSON.stringify(rows)).not.toContain('secret')
 }finally{connection.close();channel.close()}
})

test('recreated channels with reset IDs preserve unambiguous diagnostic correlation',async()=>{
 const a=fixture(),b=fixture();const one=a.client.request('canvas','stats'),two=b.client.request('canvas','stats')
 expect(a.sent[0].id).toBe(b.sent[0].id)
 expect(a.sent[0].diagnostics.originChannelId).not.toBe(b.sent[0].diagnostics.originChannelId)
 for(const f of [a,b]){expect(f.rows[0].originChannelId).toBe(f.sent[0].diagnostics.originChannelId);f.reply({id:1,value:1});f.client.close()}
 await Promise.all([one,two])
 expect(sanitizeFields({originChannelId:0xffffffffffff+1})).toEqual({})
 expect(sanitizeFields({originChannelId:1.5})).toEqual({})
})
