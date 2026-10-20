/** Bounded software observations, never physical display FPS or visual correctness.
 * Fixed buckets report a P95 upper bound (last bucket saturates at 120 s).
 * Coordinates are retained only for bounded comparison, never emitted. */
type Camera = { x: number; y: number; zoom: number }
type Sink = (event: string, fields: Record<string, number>) => void
const limits = [8, 16.7, 25, 34, 50, 100, 250, 1000, 5000, 120000]
class Histogram {
  bins = limits.map(() => 0); count = 0; max = 0; capped = false
  add(ms: number) { if (!Number.isFinite(ms) || ms < 0) return; if(ms>120000)this.capped=true; ms = Math.min(ms, 120000); this.bins[Math.max(0, limits.findIndex(n => ms <= n))]++; this.count++; this.max = Math.max(this.max, ms) }
  p95() { let count = 0; for (let i=0;i<limits.length;i++) { count += this.bins[i]; if (this.count && count >= Math.ceil(this.count*.95)) return limits[i] } return 0 }
}
export class FrameMeasurements {
  private start: number
  private visible = true
  private uiAt?: number; private submitAt?: number
  private ui = new Histogram(); private submits = new Histogram(); private latency = new Histogram()
  private counters = this.empty()
  private submitSpan = 0; private submitIntervals = 0
  private requests = new Map<number, {view:Camera; inputSequence:number; inputEpoch:number}>()
  private latestSequence = 0; private submittedSequence = 0; private observedInput = 0
  private previous?: Camera; private previousDpr = 1
  private pendingInputEpoch = 0
  constructor(private sink: Sink, private now = () => performance.now(), private epoch = () => performance.timeOrigin + performance.now()) { this.start = now() }
  private empty() { return {uiFrames:0,softwareSubmits:0,uiLongFrames:0,uiStalls:0,staleCameraSubmits:0,outOfOrderSubmits:0,transformMismatch:0,phaseChanges:0,sameCameraSubmits:0,changedCameraSubmits:0,uncorrelatedSubmits:0} }
  input(sequence:number, epoch:number) { if(this.visible && sequence>this.observedInput && Number.isFinite(epoch))this.pendingInputEpoch=epoch }
  request(sequence:number, view:Camera, input:Record<string,number> = {}) {
    if (!this.visible) return
    this.latestSequence = sequence
    const inputEpoch = input.inputAt + input.inputTimeOrigin
    this.requests.set(sequence, {view:{...view},inputSequence:input.inputSequence || 0,inputEpoch:Number.isFinite(inputEpoch)?inputEpoch:0})
    if (Number.isFinite(inputEpoch) && input.inputSequence > this.observedInput) this.pendingInputEpoch = inputEpoch
    while(this.requests.size>256) this.requests.delete(this.requests.keys().next().value!)
  }
  raf(at=this.now()) {
    if (!this.visible) return
    if(this.uiAt!==undefined) { const gap=at-this.uiAt; this.ui.add(gap); if(gap>50)this.counters.uiLongFrames++; if(gap>250)this.counters.uiStalls++ }
    this.uiAt=at; this.counters.uiFrames++; this.tick(at)
  }
  submit(sequence:number, view:Camera, dpr:number, submittedEpoch:number) {
    if (!this.visible || !Number.isFinite(submittedEpoch)) return
    const at=this.now()
    // Timestamp is recorded immediately after queue.submit in the worker; IPC arrival is not submission cadence.
    if(this.submitAt!==undefined) {
      const gap=submittedEpoch-this.submitAt
      this.submits.add(gap)
      // Receipt bursts cannot inflate this rate: only strictly increasing
      // worker epochs contribute an interval and its actual elapsed span.
      if(gap>0) {this.submitSpan+=gap;this.submitIntervals++}
    }
    this.submitAt=Math.max(this.submitAt??submittedEpoch,submittedEpoch); this.counters.softwareSubmits++
    if(sequence<this.latestSequence)this.counters.staleCameraSubmits++
    if(sequence<this.submittedSequence)this.counters.outOfOrderSubmits++
    this.submittedSequence=Math.max(sequence,this.submittedSequence)
    const target=this.requests.get(sequence)
    if(!target)this.counters.uncorrelatedSubmits++
    else {
      if(target.view.x!==view.x || target.view.y!==view.y || target.view.zoom!==view.zoom)this.counters.transformMismatch++
      if(target.inputSequence>this.observedInput && target.inputEpoch>0 && submittedEpoch>=target.inputEpoch) {
        this.latency.add(submittedEpoch-target.inputEpoch);this.observedInput=target.inputSequence
        if(target.inputEpoch>=this.pendingInputEpoch)this.pendingInputEpoch=0
      }
    }
    if(this.previous) {
      const same=this.previous.x===view.x&&this.previous.y===view.y&&this.previous.zoom===view.zoom
      this.counters[same?'sameCameraSubmits':'changedCameraSubmits']++
      const phase=(n:number)=>((n%1)+1)%1
      if(Math.abs(phase(this.previous.x*this.previousDpr)-phase(view.x*dpr))>1e-6 || Math.abs(phase(this.previous.y*this.previousDpr)-phase(view.y*dpr))>1e-6)this.counters.phaseChanges++
    }
    this.previous={...view};this.previousDpr=dpr;this.tick(at)
  }
  tick(at=this.now()) { if(this.visible && at-this.start>=1000)this.flush(0,at) }
  visibility(visible:boolean) { if(visible===this.visible)return;this.flush(visible?2:1);this.visible=visible;this.clearCorrelation() }
  reset() { this.flush(3);this.clearCorrelation() }
  private clearCorrelation() { this.uiAt=undefined;this.submitAt=undefined;this.requests.clear();this.latestSequence=0;this.submittedSequence=0;this.observedInput=0;this.previous=undefined;this.pendingInputEpoch=0 }
  private flush(reason:number, at=this.now()) {
    const duration=Math.max(0,at-this.start)
    if(this.visible && duration>0) { try { this.sink('frame-window',{...this.counters,windowMs:Math.min(duration,120000),windowCapped:Number(duration>120000),windowResetReason:reason,
      uiFps:1000*this.counters.uiFrames/duration,softwareSubmitHz:this.submitSpan>0?1000*this.submitIntervals/this.submitSpan:0,
      softwareRateValid:Number(this.submitSpan>0),submitIntervalCount:this.submitIntervals,
      submitSampleSpanMs:Math.min(120000,this.submitSpan),submitSpanCapped:Number(this.submitSpan>120000),
      uiIntervalP95Ms:this.ui.p95(),uiIntervalMaxMs:this.ui.max,uiIntervalCapped:Number(this.ui.capped),submitIntervalP95Ms:this.submits.p95(),submitIntervalMaxMs:this.submits.max,submitIntervalCapped:Number(this.submits.capped),
      inputPresentCount:this.latency.count,inputPresentP95Ms:this.latency.p95(),inputPresentMaxMs:this.latency.max,inputPresentCapped:Number(this.latency.capped),
      pendingInputAgeCapped:Number(!!this.pendingInputEpoch&&this.epoch()-this.pendingInputEpoch>120000),
      pendingInputAgeMs:this.pendingInputEpoch?Math.min(120000,Math.max(0,this.epoch()-this.pendingInputEpoch)):0}) } catch {} }
    this.start=at;this.counters=this.empty();this.submitSpan=0;this.submitIntervals=0;this.ui=new Histogram();this.submits=new Histogram();this.latency=new Histogram()
  }
}
