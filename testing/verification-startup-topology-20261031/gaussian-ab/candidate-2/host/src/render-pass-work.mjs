// Encoded draw counts, not GPU time. Unknown modes retain their own bucket.
// Synthetic lanes: 64 = solid instance batch, 63 = stencil coverage.
// Shader modes 60/61/62 are color controls, motion blur and zoom blur.
const groups=['Coverage','Paint','Merge','Effect','Copy','Present','PaintMerge','Resolve','Other']
export const fastPathKeys=['fastSampleOnlyPasses','fastSampleOnlyPixels','fastPackedCoveragePasses','fastCanvasBlurPasses','fastCanvasMotionPasses','fastCanvasZoomPasses','fastSolidAttempts','fastSolidBatches','fastSolidNodes','fastSolidTargetReject','fastSolidProofReject','fastSolidCapacityReject',
 'fastCoverageConstant','fastCoverageShared','fastCoverageRejected','fastCoverageCacheHits','fastCoverageCacheMissKeys','fastCoverageCacheMissWords','fastCoverageCacheOversize','fastCoverageCachePinned',
 'fastGradientFused','fastGradientPaintReject','fastGradientLatticeReject','fastGradientCoverageReject','fastGradientColorReject',
 'fastRegionalUsed','fastRegionalSharedReject','fastRegionalFeedbackReject','fastRegionalLatticeReject','fastRegionalLargeReject',
 'fastRegionalPixels','fastRegionalFullPixels','fastGradientSavedPixels','fastCoverageSavedPixels']
export const drawWorkLimits={drawWorkVersion:2,drawWorkCapped:1,clearPasses:1e9,drawPixelsMeasuredDraws:1e9,drawPixelsUnmeasuredDraws:1e9,...Object.fromEntries(groups.map(name=>['draw'+name,1e9])),
  ...Object.fromEntries(groups.map(name=>['drawPixels'+name,1e15])),
  ...Object.fromEntries(fastPathKeys.map(name=>[name,1e15])),
  ...Object.fromEntries(Array.from({length:66},(_,mode)=>['drawMode'+mode,1e9]))}
const group=mode=>[1,17,19,20,30,31,63].includes(mode)?'Coverage':[2,12].includes(mode)?'Paint':[3,15,25,28,29].includes(mode)?'Merge':
 [4,5,6,7,8,9,10,11,22,34,40,41,43,45,46,50,60,61,62].includes(mode)?'Effect':
 [0,27,44].includes(mode)?'Copy':[14,18,33].includes(mode)?'Present':[16,35,42,47,64,65].includes(mode)?'PaintMerge':
 [21,23,24,26,36].includes(mode)?'Resolve':'Other'
export class PassDrawWork {
  enabled=false
  values={}
  reset(enabled){this.enabled=enabled;this.values=enabled?{drawWorkVersion:2,drawWorkCapped:0,clearPasses:0,...Object.fromEntries(groups.map(name=>['draw'+name,0]))}:{} }
  add(key,count){const limit=drawWorkLimits[key]||1e9,next=(this.values[key]||0)+count;this.values[key]=Math.min(limit,next);if(next>limit)this.values.drawWorkCapped=1}
  draw(mode,count=1,pixels){
    if(!this.enabled||!Number.isInteger(count)||count<0)return
    this.add('draw'+group(mode),count)
    if(Number.isInteger(mode)&&mode>=0&&mode<66)this.add('drawMode'+mode,count)
    if(Number.isSafeInteger(pixels)&&pixels>=0){this.add('drawPixels'+group(mode),pixels);this.add('drawPixelsMeasuredDraws',count)}
    else this.add('drawPixelsUnmeasuredDraws',count)
  }
  clear(){if(this.enabled)this.add('clearPasses',1)}
  snapshot(){return {...this.values}}
}
/** Numeric reason counters only; never stores a node id or document payload. */
export class FastPathWork {
 enabled=false
 values={}
 reset(enabled){this.enabled=enabled;this.values={}}
 add(key,count=1){if(this.enabled&&fastPathKeys.includes(key)&&Number.isSafeInteger(count)&&count>=0)this.values[key]=Math.min(1e15,(this.values[key]||0)+count)}
 snapshot(){return {...this.values}}
}
