import { createRenderDiagnostics, sanitizeFields, PREFIX } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
let owners=0
export const gestureCode=(kind?:string)=>(({move:1,rotate:2,resize:3,scale:4} as Record<string,number>)[kind||'']||0)
/** Decisions:1 owner,2 exact floor,3 capture start,4 accept,5 reject,6 hide,7 retire.
 * Reasons:0 normal,1 affine guard,2 translation,3 fractional handoff,4 older floor,5 retired generation.
 * These are logical lifecycle observations,not GPU display acknowledgements. */
export class HandoffTrace {
 readonly owner=++owners
 private sequence=0;private dropped=0;private ringDropped=0;private window=-Infinity;private count=0;private terminalEmitted=false
 private previous=new Map<number,string>();private ring:Record<string,number>[]=[]
 constructor(private sink:(fields:Record<string,number>)=>void,readonly enabled=false,private detail=false,private now=()=>performance.now()){}
 record(decision:number,reason:number,fields:Record<string,number>={}){
  if(!this.enabled)return
  fields=sanitizeFields(fields)
  const {handoffPreviousOwnerKind:_previous,...state}=fields
  const key=JSON.stringify([reason,state]);if(this.previous.get(decision)===key)return
  const time=this.now();if(time-this.window>=1000){this.window=time;this.count=0;this.terminalEmitted=false}
  if(this.count>=(this.detail?64:16)&&!(decision===7&&!this.terminalEmitted)){this.dropped++;return}
  this.count++;if(decision===7)this.terminalEmitted=true
  this.previous.set(decision,key)
  const row={...fields,handoffOwner:this.owner,handoffSequence:++this.sequence,handoffDecision:decision,handoffReason:reason,handoffDropped:this.dropped,handoffRingDropped:this.ringDropped}
  if(this.ring.length>=(this.detail?256:128)){this.ring.shift();this.ringDropped++;row.handoffRingDropped=this.ringDropped}
  this.ring.push(row);try{this.sink(row)}catch{/* Diagnostics cannot break an edit. */}
 }
 snapshot(){return {records:this.ring.map(row=>({...row})),dropped:this.dropped,ringDropped:this.ringDropped}}
}
export function createHandoffTrace(){
 const host=typeof window==='undefined'?undefined:(window as unknown as {coreDesktop?:{renderDiagnostics?:boolean;renderDiagnosticsDetail?:boolean}}).coreDesktop
 const terminal=createRenderDiagnostics({enabled:host?.renderDiagnostics===true,detail:host?.renderDiagnosticsDetail===true,session:Math.floor(Math.random()*1e11),source:'main',sink:row=>console.log(PREFIX+JSON.stringify(row)),batchSink:batch=>console.log(PREFIX+JSON.stringify({batch}))})
 return new HandoffTrace(fields=>{terminal.record('handoff-trace',fields);terminal.flush()},terminal.enabled,terminal.detail)
}
