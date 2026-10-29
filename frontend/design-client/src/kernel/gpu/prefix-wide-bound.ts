declare const wideBrand:unique symbol
export type WidePrefixCertificate=Readonly<{[wideBrand]:true}>
const proofs=new WeakMap<WidePrefixCertificate,{reach:number;integer:number;fractional:number;limit:number}>()
/** Exact original coefficients, never rounded radii. The scan still uses its
 * old 128-bit/4 MiB layout; only bounded weighted window arithmetic widens. */
export function certifyWidePrefix(bytes:Uint8Array):WidePrefixCertificate|undefined{return certify(bytes,512)}
/** Independent large-kernel candidate; retains the same 184-bit bound and normalization proof. */
export function certifyLargeWidePrefix(bytes:Uint8Array):WidePrefixCertificate|undefined{return certify(bytes,2048)}
export function certifyShadowWidePrefix(bytes:Uint8Array):WidePrefixCertificate|undefined{return certify(bytes,4096)}
function certify(bytes:Uint8Array,limit:512|2048|4096):WidePrefixCertificate|undefined{
 if(!(bytes instanceof Uint8Array)||!(bytes.buffer instanceof ArrayBuffer)||bytes.byteLength<16||bytes.byteLength%4)return
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),cw=view.getUint32(0,true),reach=view.getUint32(8,true)
 if(cw<1||cw>6||reach<32||reach>limit||view.getUint32(12,true)!==0||bytes.byteLength!==4*(4+cw*(reach+2)))return
 const word=(index:number)=>{let n=0n;for(let i=cw-1;i>=0;i--)n=n<<32n|BigInt(view.getUint32((4+index*cw+i)*4,true));return n}
 const denominator=word(0)
 if(denominator<=0n||denominator>=1n<<184n||view.getUint32(4,true)!==Math.ceil((denominator.toString(2).length+278)/32))return
 const coefficients=Array.from({length:reach+1},(_,i)=>word(i+1))
 if(coefficients.some(value=>value>denominator)||coefficients[0]+2n*coefficients.slice(1).reduce((a,b)=>a+b,0n)!==denominator)return
 const center=coefficients[0],slope=coefficients[1]-coefficients[2],intercept=coefficients[1]+slope
 if(center===0n||slope<0n)return
 const bound=(interior:number)=>{
  for(let i=1;i<=interior;i++)if(coefficients[i]!==intercept-BigInt(i)*slope)return 0
  const n=BigInt(interior)
  let value=center+2n*n*intercept+n*(n+1n)*slope
  for(let i=interior+1;i<=reach;i++)value+=2n*coefficients[i]
  return value>0n&&value<1n<<184n?value.toString(2).length:0
 }
 const integer=bound(reach-1),fractional=bound(reach-2)
 if(!integer&&!fractional)return
 const proof=Object.freeze({}) as WidePrefixCertificate;proofs.set(proof,{reach,integer,fractional,limit});return proof
}
export function widePrefixBoundBits(proof:WidePrefixCertificate|undefined,radius:number){
 const value=proof&&proofs.get(proof)
 if(!value||!Number.isFinite(radius)||radius<32||radius>value.limit||Math.ceil(radius)!==value.reach)return 0
 return Number.isInteger(radius)?value.integer:value.fractional
}
