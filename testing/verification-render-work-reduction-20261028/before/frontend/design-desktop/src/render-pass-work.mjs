// Encoded draw counts, not GPU time. Unknown modes retain their own bucket.
// Synthetic lanes: 64 = solid instance batch, 63 = stencil coverage.
// Shader modes 60/61/62 are color controls, motion blur and zoom blur.
const groups=['Coverage','Paint','Merge','Effect','Copy','Present','PaintMerge','Other']
export const drawWorkLimits={drawWorkCapped:1,clearPasses:1e9,...Object.fromEntries(groups.map(name=>['draw'+name,1e9])),
  ...Object.fromEntries(Array.from({length:65},(_,mode)=>['drawMode'+mode,1e9]))}
const group=mode=>[17,19,20,31,63].includes(mode)?'Coverage':mode===2?'Paint':mode===3?'Merge':[22,60,61,62].includes(mode)?'Effect':
  mode===0?'Copy':[14,33].includes(mode)?'Present':[47,64].includes(mode)?'PaintMerge':'Other'
export class PassDrawWork {
  enabled=false
  values={}
  reset(enabled){this.enabled=enabled;this.values=enabled?{drawWorkCapped:0,clearPasses:0,...Object.fromEntries(groups.map(name=>['draw'+name,0]))}:{} }
  add(key,count){const next=(this.values[key]||0)+count;this.values[key]=Math.min(1e9,next);if(next>1e9)this.values.drawWorkCapped=1}
  draw(mode,count=1){
    if(!this.enabled||!Number.isInteger(count)||count<0)return
    this.add('draw'+group(mode),count)
    if(Number.isInteger(mode)&&mode>=0&&mode<65)this.add('drawMode'+mode,count)
  }
  clear(){if(this.enabled)this.add('clearPasses',1)}
  snapshot(){return {...this.values}}
}
