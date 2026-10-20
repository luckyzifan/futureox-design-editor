import { PreparationStates } from './preparation-state'
import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { PreparationChannel } from './preparation-channel'
test('actual WASM worker control flow emits start/finish without content or resolving progress as a reply',async()=>{
 const source=readFileSync(new URL('./preparation-worker.ts',import.meta.url),'utf8')
 const js=stripTypeScriptTypes(source).replace(/^import .*$/gm,'').replaceAll('import.meta.env','env')
 const self:any={},rows:any[]=[]
 class Engine { load_font(){} set_image_mips(){} color_settings(){return 'null'} free(){} compile_gpu_packet(value:string){if(value==='throw')throw Error('private exception');return new Uint8Array([70,71])} }
 class Snapshots {imageMips(){return false}canFork(){return false}initialize(){}invalidate(){}loaded(){}}
 new Function('initialize','VectorEngine','renderCpuFrame','loadKernelResources','PreparationSnapshots','PreparationStates','self','MessagePort','env',js)(async()=>{},Engine,()=>{},async()=>new Uint8Array(),Snapshots,PreparationStates,self,MessagePort,{DEV:false,VITE_DESIGN_DOCUMENT_FORK:'0'})
 const pair=new MessageChannel(),channel=new PreparationChannel(pair.port2,{enabled:()=>true,owner:()=>954,record:(_e,r)=>rows.push(r)})
 self.onmessage({data:{port:pair.port1}})
 try{
 expect((await channel.request('canvas','compile_gpu_packet',['private payload'])).value).toEqual(new Uint8Array([70,71]))
 expect(rows.filter(r=>r.phase===5).map(r=>r.boundaryCode)).toEqual([1,7,2,3]);expect(rows.at(-1).phase).toBe(4)
 expect(rows.filter(r=>r.phase===5).every(r=>r.backendCode===1)).toBe(true)
 await expect(channel.request('canvas','compile_gpu_packet',['throw'])).rejects.toThrow('private exception')
 expect((await channel.request('canvas','compile_gpu_packet',['recovery'])).value).toEqual(new Uint8Array([70,71]))
 expect(JSON.stringify(rows)).not.toMatch(/private payload|private exception|recovery/)
 }finally{channel.close();pair.port1.close()}
})
