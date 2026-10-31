/** Exact metadata records emitted by Rust's serde adapter. No scene JSON parse. */
export function decodeFrameValue(bytes: Uint8Array): any {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), strings:string[]=[]
  const decoder=new TextDecoder('utf-8',{fatal:true});let at=0
  const need=(n:number)=>{if(n>bytes.length-at)throw Error('Truncated frame metadata')}
  const word=()=>{need(4);const n=view.getUint32(at,true);at+=4;return n}
  const value=():any=>{
    need(1);const tag=bytes[at++]
    if(tag===1)return null
    if(tag===2||tag===3)return tag===3
    if(tag===4){need(8);const n=view.getFloat64(at,true);at+=8;if(!Number.isFinite(n))throw Error('Invalid frame number');return n}
    if(tag===5){const i=word();if(i>=strings.length)throw Error('Invalid frame string reference');return strings[i]}
    if(tag===6){const n=word();need(n);const text=decoder.decode(bytes.subarray(at,at+n));at+=n;strings.push(text);return text}
    if(tag===7){const result=[];while(true){need(1);if(bytes[at]===0){at++;return result}result.push(value())}}
    if(tag===8){const result:Record<string,unknown>={};while(true){need(1);if(bytes[at]===0){at++;return result}
      const key=value();if(typeof key!=='string'||Object.hasOwn(result,key))throw Error('Invalid frame map key')
      const decoded=value()
      // Ordinary metadata fields need no descriptor allocation. Preserve an
      // own __proto__ data property without invoking Object.prototype's setter.
      if(key==='__proto__')Object.defineProperty(result,key,{value:decoded,enumerable:true,writable:true,configurable:true})
      else result[key]=decoded}}
    throw Error('Unknown frame metadata tag')
  }
  const result=value();if(at!==bytes.length)throw Error('Trailing frame metadata');return result
}
