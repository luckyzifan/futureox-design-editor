import { expect, test, vi, afterEach } from 'vitest'
import { ResidentPresenter } from './resident-presenter'
import { TerminalQualityGate, terminalQualityMessage } from './terminal-quality'
import { residentFrameMessage, residentFrameSignature } from './resident-frame'
import { presentationQuality } from './presentation-quality'
import { compositeDrawPlan, compositeRasterQuad } from './composite-draw-plan'
import { physicalCoverage } from './physical-coverage'
import { sanitizeFields, setGpuDiagnosticsDetail } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();setGpuDiagnosticsDetail(false)})
const marker={qualitySequence:1,qualityRevision:2,pageToken:1,documentRevision:3,generation:70,fillGeneration:271}
test('terminal marker is numeric-only and wire/signature preserve explicit completion transition',()=>{
 const raw={...marker,document:{secret:'private'},options:'secret'}
 expect(terminalQualityMessage(raw)).toEqual(marker)
 for(const value of [-1,NaN,Infinity,1.5,0x100000000,'1'])expect(terminalQualityMessage({...marker,qualitySequence:value})).toBeUndefined()
 const frame:any={items:[],view:{x:0,y:0,zoom:1},width:100,height:100,dpr:1,terminalQuality:raw}
 const wire=residentFrameMessage(frame);expect(wire.terminalQuality).toEqual(marker)
 expect(JSON.stringify(wire)).not.toContain('secret')
 expect(residentFrameSignature(frame)).not.toBe(residentFrameSignature({...frame,terminalQuality:undefined}))
 for(const value of [-1,NaN,Infinity,'1',1.5,0x100000000])expect(sanitizeFields({qualitySequence:value,qualityRevision:value,documentRevision:value})).toEqual({})
})
test('gate is bounded and does not consume a completion while diagnostics disabled',()=>{
 const gate=new TerminalQualityGate()
 expect(gate.claim(marker,false)).toBeUndefined();expect(gate.claim(marker,true)).toEqual(marker)
 expect(gate.claim(marker,true)).toBeUndefined();expect(gate.claim({...marker,qualitySequence:0},true)).toBeUndefined()
 expect(gate.claim({...marker,qualitySequence:2},true)?.qualitySequence).toBe(2)
})
test('actual resident draw forces a measured post-complete low-density sample inside250ms throttle, without readback/fence',()=>{
 vi.stubEnv('DEV',false)
 setGpuDiagnosticsDetail(true)
 const reports:any[]=[],pass={setScissorRect(){},setPipeline(){},setBindGroup(){},draw(){},end(){}}
 const submit=vi.fn(),wait=vi.fn(()=>{throw Error('unexpected GPU fence')})
 const p=Object.assign(Object.create(ResidentPresenter.prototype),{terminalQualityGate:new TerminalQualityGate(),diagnosticCoverageAt:100,diagnosticFields:()=>({}),payload:{assertOpen(){}},frames:0,imports:0,captures:0,bytes:0,
  device:{limits:{maxTextureDimension2D:4096},queue:{submit,onSubmittedWorkDone:wait},createCommandEncoder:()=>({beginRenderPass:()=>pass,copyTextureToTexture(){},finish(){return {}}})},
  textures:new Map([[42,{texture:{},bind:{},bytes:100}]]),canvas:{width:100,height:100},context:{getCurrentTexture:()=>({})},
  backbuffer:{width:100,height:100,texture:{createView:()=>({})}},transformData:{begin(){},set(){},changed(){return undefined}},report:(r:any)=>reports.push(r)})
 vi.spyOn(performance,'now').mockReturnValue(200)
 const frame:any={view:{x:0,y:0,zoom:1},width:100,height:100,dpr:1,terminalQuality:marker,items:[{active:true,layer:1,tile:{gpuTile:42,key:'private',serial:1,x:-1,y:-1,width:52,height:52,zoom:.5}}]}
 p.draw(frame)
 expect(reports.at(-1)).toMatchObject({...marker,qualityTerminal:true,coverageMeasured:true,sharpCoverage:0,maxUpscale:2})
 expect(reports.at(-1).coverageAt).toBe(200)
 p.draw(frame);expect(reports.at(-1).qualityTerminal).toBeUndefined();expect(reports.at(-1).coverageMeasured).toBe(false)
 p.draw({...frame,terminalQuality:{...marker,qualitySequence:2}});expect(reports.at(-1).qualityTerminal).toBe(true)
 setGpuDiagnosticsDetail(false);p.draw({...frame,terminalQuality:{...marker,qualitySequence:3}});expect(reports.at(-1).coverageMeasured).toBe(false)
 expect(wait).not.toHaveBeenCalled();expect(submit).toHaveBeenCalledTimes(4)
})
