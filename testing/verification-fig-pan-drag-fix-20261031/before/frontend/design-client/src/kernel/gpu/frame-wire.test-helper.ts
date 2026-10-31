// Independent test-only encoder; production metadata is emitted only by Rust.
export function frameValue(value:unknown):Uint8Array {
  const out:number[]=[];const u32=(v:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);out.push(...b)}
  const put=(v:any)=>{
    if(v===null){out.push(1);return}if(typeof v==='boolean'){out.push(v?3:2);return}
    if(typeof v==='number'){const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,v,true);out.push(4,...b);return}
    if(typeof v==='string'){const b=new TextEncoder().encode(v);out.push(6);u32(b.length);for(const byte of b)out.push(byte);return}
    if(Array.isArray(v)){out.push(7);v.forEach(put);out.push(0);return}
    out.push(8);for(const [key,item] of Object.entries(v)){put(key);put(item)}out.push(0)
  };put(value);return new Uint8Array(out)
}
export function emptyFrame(value=0):Uint8Array {
  const metadata=frameValue({version:8,roots:[],nodes:{},resourceScope:'',frameSequence:1,nodeResources:[],scenePlan:1,width:value})
  const plan=frameValue({version:1,nodes:[],roots:[],parents:[],rootFor:[],unknownEffectSubtrees:[],imageUses:[],features:0})
  const start=Math.ceil((24+metadata.length)/4)*4, bytes=new Uint8Array(start+9+plan.length), view=new DataView(bytes.buffer)
  ;[0x43534746,1,metadata.length,0,0,plan.length+9].forEach((v,i)=>view.setUint32(i*4,v,true))
  bytes.set(metadata,24);view.setUint32(start,1,true);bytes[start+4]=3;view.setUint32(start+5,plan.length,true);bytes.set(plan,start+9);return bytes
}
