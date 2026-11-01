/** Display Gaussian only. This chooses execution of the existing box packet;
 * it changes neither sigma, support, intermediate density nor the six passes.
 * Small/cropped work stays direct to avoid a full source-line scan. */
export function gaussianPrefixWorthwhile(radius:number,sourceLength:number,targetLength:number,targetPixels:number){
  return Number.isInteger(radius)&&radius>=32&&radius<=512&&
    Number.isSafeInteger(sourceLength)&&sourceLength>0&&sourceLength<=16384&&
    Number.isSafeInteger(targetLength)&&targetLength>0&&
    Number.isSafeInteger(targetPixels)&&targetPixels>=4096&&
    sourceLength<=targetLength*radius
}

/** Preparation hint only. Physical resources, packet identity, integer
 * sampling geometry, SDR intent and remaining scratch budget are checked
 * again by the driver at dispatch. */
export function gaussianPrefixDemand(node:{rect:{w:number;h:number};matrix:number[];effects:{kind:string;visible:boolean;radius:number}[]}){
  if(!node.matrix||node.matrix.length<4||!node.rect)return false
  const [a,b,c,d]=node.matrix,s=a*a+b*b+c*c+d*d,det=a*d-b*c
  const scale=Math.sqrt((s+Math.sqrt(Math.max(0,s*s-4*det*det)))/2)
  return node.rect.w*node.rect.h>=4096&&node.effects.some(e=>
    e.visible&&e.kind==='gaussian-blur'&&Number.isFinite(e.radius*scale)&&e.radius*scale>=32)
}
