import { createRenderDiagnostics, PREFIX } from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
/** Stages: 1 submit, 2 native sample, 3 compositor ACK, 4 rejection,
 * 5 gesture end, 6 invalidation, 7 fallback, 8 accepted feedback.
 * Reasons: 0 none, 1 owner, 2 document, 3 unknown sequence, 4 no frame,
 * 5 render error, 6 after end/disposal, 7 stale sequence, 8 reserved,
 * 9 slot, 10 needs rebase, 11 no resident, 12 immediate path, 13 unsupported patch.
 * This is callback evidence, never proof of physical display scanout. */
export class PoseDiagnostics {
  private gesture=0; private closed=true; private emitted=0; private last=-Infinity
  private seen=new Set<number>(); private pending=new Map<number,number>()
  private evictedOldest:number|undefined; private evictedThrough=0
  private suppressed=0; private suppressedCapped=false
  private submitted=0; private sampled=0; private acknowledged=0; private accepted=0; private rejected=0; private evicted=0
  constructor(private sink:(fields:Record<string,number>)=>void, private now=()=>performance.now(), readonly enabled=true) {}
  record(stage:number,reason:number,sequence:number,context:Record<string,number>={}) {
    if(!this.enabled||(stage===5&&this.closed))return
    const now=this.now()
    if(stage===1&&this.closed){this.gesture++;this.closed=false;this.emitted=0;this.last=-Infinity;this.seen.clear();this.pending.clear();this.evictedOldest=undefined;this.evictedThrough=0;this.suppressed=0;this.suppressedCapped=false;this.submitted=this.sampled=this.acknowledged=this.accepted=this.rejected=this.evicted=0}
    if(stage===1){this.submitted++; if(context.poseDeferred){this.pending.set(sequence,now);if(this.pending.size>180){const oldest=this.pending.keys().next().value!;this.evictedOldest??=this.pending.get(oldest);this.evictedThrough=oldest;this.pending.delete(oldest);this.evicted++}}}
    if(stage===2)this.sampled++
    if(stage===3)this.acknowledged++
    if(stage===4)this.rejected++
    if(stage===8){this.accepted++;if(sequence>=this.evictedThrough)this.evictedOldest=undefined;for(const key of this.pending.keys())if(key<=sequence)this.pending.delete(key)}
    const terminal=stage===5&&!this.closed, key=stage*128+reason*4+(context.poseSampleKind||0), first=!this.seen.has(key)
    if(terminal||(stage===4&&reason===6&&this.closed&&first)||(this.emitted<32&&(first||now-this.last>=250))){
      this.seen.add(key);this.emitted++;this.last=now
      const fields={...context,poseStage:stage,poseReason:reason,poseSequence:sequence,poseGesture:this.gesture,
        poseSuppressedCount:this.suppressed,poseSuppressedCapped:Number(this.suppressedCapped),
        poseSubmittedCount:this.submitted,poseSampledCount:this.sampled,poseAckCount:this.acknowledged,
        poseAcceptedCount:this.accepted,poseRejectedCount:this.rejected,poseEvictedCount:this.evicted,
        posePendingCount:this.pending.size,posePendingCapped:Number(this.evictedOldest!==undefined),poseOldestAgeMs:Math.min(600000,Math.max(0,Math.round(now-(this.evictedOldest??this.pending.values().next().value??now))))}
      try{this.sink(fields)}catch{/* Logging cannot reject an edit. */}
    } else {
      // Count instrumentation sampling omissions, not discarded input or frames.
      if(this.suppressed<1e9)this.suppressed++;else this.suppressedCapped=true
    }
    if(stage===5){this.closed=true;this.pending.clear()}
    if(stage===6){this.pending.clear();this.evictedOldest=undefined;this.evictedThrough=0}
  }
}
export function createPoseDiagnostics(owner:number) {
 const host=typeof window==='undefined'?undefined:(window as unknown as {coreDesktop?:{renderDiagnostics?:boolean;renderDiagnosticsDetail?:boolean}}).coreDesktop
 const terminal=createRenderDiagnostics({enabled:host?.renderDiagnostics===true,detail:host?.renderDiagnosticsDetail===true,session:Math.floor(Math.random()*1e11),source:'main',sink:row=>console.log(PREFIX+JSON.stringify(row)),batchSink:batch=>console.log(PREFIX+JSON.stringify({batch}))})
 return new PoseDiagnostics(fields=>{terminal.record('pose-lifecycle',{interactionOwner:owner,...fields});if(fields.poseStage===5)terminal.flush()},undefined,terminal.enabled)
}
