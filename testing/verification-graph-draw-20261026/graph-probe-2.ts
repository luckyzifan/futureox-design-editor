import {captureDeviceDiagnosticRequest} from './device-lifecycle-diagnostics'
const states=new WeakMap<object,any>()
let serial=0
export function graphProbeBegin(driver:any,scene:any,context:()=>any){
  if(import.meta.env.VITE_DESIGN_GRAPH_PROFILE!=='1')return undefined
  let state=states.get(driver)
  if(!state){
    state={};states.set(driver,state)
    for(const name of ['pass','over','clear','copyColorRegion','copyRegion']){
      if(typeof driver[name]!=='function')continue
      const original=driver[name]
      driver[name]=function(...args:any[]){
        const f=state.frame;if(!f)return original.apply(this,args)
        const [target,u]=args,mode=name==='pass'||name==='over'?u[16]:name
        const key=JSON.stringify([mode,mode===2?u[28]:null,mode===3?u[17]:null,args[4]??15])
        const row=f.modes[key]??={mode,paint:mode===2?u[28]:undefined,blend:mode===3?u[17]:undefined,calls:0,draws:0,pixels:0,targetPixels:0,encodeMs:0}
        const old=this.drawCalls||0,at=performance.now(),region=name==='pass'||name==='over'?args[3]:args[2]
        try{return original.apply(this,args)}finally{
          const draws=Math.max(0,(this.drawCalls||0)-old),pixels=region?.w!==undefined?region.w*region.h:target.width*target.height
          if(mode===0){row.zeroCopies=(row.zeroCopies||0)+Number(!!args[2]?.[0]?.transparentZero);row.constantCopies=(row.constantCopies||0)+Number(!!args[2]?.[0]?.uniformColor)}
          if(mode===3){row.zeroSources=(row.zeroSources||0)+Number(!!args[2]?.[0]?.transparentZero);row.zeroDestinations=(row.zeroDestinations||0)+Number(!!args[2]?.[1]?.transparentZero)}
          row.calls++;row.draws+=draws;row.pixels+=pixels*Math.max(1,draws);row.targetPixels+=target.width*target.height;row.encodeMs+=performance.now()-at
          f.draws+=draws
          const n=f.context(),node=n?.node
          if(node){let visit=f.nodes.get(node.id);if(!visit){visit={kind:node.kind,children:node.children.length,fills:node.fills.length,strokes:node.strokes.length,effects:node.effects.filter((e:any)=>e.visible).map((e:any)=>e.kind),draws:0,pixels:0,modes:{}};f.nodes.set(node.id,visit)}
            visit.draws+=draws;visit.pixels+=pixels*Math.max(1,draws);visit.modes[mode]=(visit.modes[mode]||0)+draws}
        }
      }
    }
  }
  const frame:any={serial:++serial,at:Date.now(),request:captureDeviceDiagnosticRequest(),output:scene.output,extent:scene.extent,
    coherent:scene.coherentSamples,nodes:new Map(),modes:{},draws:0,context,waits:[],since:{}}
  state.frame=frame
  return (completed:boolean)=>{
    if(state.frame===frame)state.frame=undefined
    const {context,nodes,since,...record}=frame
    record.gpuTimings=driver.passTimings;record.gpuTimingSkipped=driver.timingSkipped;record.completed=completed;record.actualDraws=driver.drawCalls;record.unaccountedDraws=(driver.drawCalls||0)-frame.draws
    record.nodeCount=nodes.size;record.topNodes=[...nodes.values()].sort((a:any,b:any)=>b.pixels-a.pixels).slice(0,12)
    record.waits=frame.waits
    console.debug('DESIGN_GRAPH_FRAME '+JSON.stringify(record))
  }
}
export function graphProbeWait(driver:any,reason:string,admission:any,asynchronous:boolean){
  if(import.meta.env.VITE_DESIGN_GRAPH_PROFILE!=='1')return undefined
  const f=states.get(driver)?.frame;if(!f)return undefined
  const at=performance.now(),modes:any={}
  for(const [key,r]of Object.entries(f.modes) as [string,any][]){const old=f.since[key]||{draws:0,pixels:0};modes[key]={draws:r.draws-old.draws,pixels:r.pixels-old.pixels};f.since[key]={draws:r.draws,pixels:r.pixels}}
  const row={reason,asynchronous,admission,modes,submittedDraws:driver.drawCalls,start:at,end:0,ms:0,outcome:0}
  f.waits.push(row)
  return (outcome:number)=>{row.end=performance.now();row.ms=row.end-at;row.outcome=outcome}
}
