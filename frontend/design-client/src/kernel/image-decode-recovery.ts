/** Independent, allocation-free canonical-base64 proof for a bounded recovery.
 * This is not source admission and never repairs/normalizes authored bytes.
 * The bound matches the existing full-image decoder's encoded allowance. */
export function canRebuildImageDecoder(error:unknown,uri:string):boolean {
  const message=typeof error==='string'?error:error instanceof Error?error.message:''
  if(message!=='Invalid image data'||uri.length>12*1024*1024)return false
  const prefix=['data:image/png;base64,','data:image/jpeg;base64,','data:image/webp;base64,','data:image/gif;base64,','data:image/tiff;base64,'].find(p=>uri.startsWith(p))
  if(!prefix)return false
  const length=uri.length-prefix.length
  if(length<4||length%4)return false
  const padding=uri.endsWith('==')?2:uri.endsWith('=')?1:0,end=uri.length-padding
  const value=(code:number)=>code>=65&&code<=90?code-65:code>=97&&code<=122?code-71:
    code>=48&&code<=57?code+4:code===43?62:code===47?63:-1
  let last=0
  for(let at=prefix.length;at<end;at++){last=value(uri.charCodeAt(at));if(last<0)return false}
  return padding===2?(last&15)===0:padding===1?(last&3)===0:true
}
