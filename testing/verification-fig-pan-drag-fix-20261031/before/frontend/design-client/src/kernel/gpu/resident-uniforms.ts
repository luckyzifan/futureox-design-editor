/** Fixed-size CPU mirror of the persistent display transform buffer. Compare
 * after f32 conversion, retain signed zero, upload one coalesced changed range. */
export class ResidentUniforms {
  readonly data: Float32Array<ArrayBuffer>
  private first = Infinity
  private last = -1
  constructor(private slots=4096) { this.data=new Float32Array(slots*64) }
  begin() { this.first=Infinity;this.last=-1 }
  set(slot:number,values:readonly number[]) {
    if(!Number.isSafeInteger(slot)||slot<0||slot>=this.slots||values.length!==12)throw Error('Invalid resident transform slot')
    const offset=slot*64
    let changed=false
    for(let i=0;i<12;i++){
      const value=Math.fround(values[i])
      if(!Object.is(this.data[offset+i],value)){this.data[offset+i]=value;changed=true}
    }
    if(changed){this.first=Math.min(this.first,slot);this.last=Math.max(this.last,slot)}
  }
  changed() {
    return this.last<0?undefined:{offset:this.first*256,data:this.data.subarray(this.first*64,(this.last+1)*64)}
  }
}
