// Encoded draw counts, not GPU time. Unknown modes retain their own bucket.
// Synthetic lanes: 61 = solid instance batch, 63 = stencil coverage.
// Mode 60 is the color-controls shader and belongs to effects.
const groups=['Coverage','Paint','Merge','Effect','Copy','Present','PaintMerge','Other']
export const drawWorkLimits={drawWorkCapped:1,clearPasses:1e9,...Object.fromEntries(groups.map(name=>['draw'+name,1e9])),
  ...Object.fromEntries(Array.from({length:64},(_,mode)=>['drawMode'+mode,1e9]))}
const group=mode=>[17,19,20,31,63].includes(mode)?'Coverage':mode===2?'Paint':mode===3?'Merge':[22,60].includes(mode)?'Effect':
  mode===0?'Copy':[14,33].includes(mode)?'Present':[47,61].includes(mode)?'PaintMerge':'Other'
export class PassDrawWork {
  enabled=false
  values={}
  reset(enabled){this.enabled=enabled;this.values=enabled?{drawWorkCapped:0,clearPasses:0,...Object.fromEntries(groups.map(name=>['draw'+name,0]))}:{} }
  add(key,count){const next=(this.values[key]||0)+count;this.values[key]=Math.min(1e9,next);if(next>1e9)this.values.drawWorkCapped=1}
  draw(mode,count=1){
    if(!this.enabled||!Number.isInteger(count)||count<0)return
    this.add('draw'+group(mode),count)
    if(Number.isInteger(mode)&&mode>=0&&mode<64)this.add('drawMode'+mode,count)
  }
  clear(){if(this.enabled)this.add('clearPasses',1)}
  snapshot(){return {...this.values}}
}
