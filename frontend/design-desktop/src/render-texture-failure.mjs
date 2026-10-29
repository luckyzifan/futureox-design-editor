// Exact owned allocation evidence. No source IDs, strings, stacks or payloads.
const records=new WeakMap()
export const textureFailureLimits={textureFailureAvailable:1,textureWidth:1e9,textureHeight:1e9,
  textureMaxDimension:1e9,textureBytesPerPixel:16,textureAllocationKind:5,
  textureAllocationSite:255,texturePass:256,textureKernelRadius:1e7,textureLogicalTexels:1e9}
export function sanitizeTextureFailure(value){
  const out={}
  if(!value||typeof value!=='object')return out
  for(const [key,max] of Object.entries(textureFailureLimits)){
    const v=Object.getOwnPropertyDescriptor(value,key)?.value
    if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(key==='textureKernelRadius'||Number.isSafeInteger(v)))out[key]=v
  }
  return out
}
export function textureAllocationError(width,height,maxDimension,bytesPerPixel){
  const error=new Error('WebGPU 纹理尺寸超限')
  records.set(error,sanitizeTextureFailure({textureFailureAvailable:1,textureWidth:width,textureHeight:height,
    textureMaxDimension:maxDimension,textureBytesPerPixel:bytesPerPixel,textureAllocationKind:1}))
  return error
}
export function annotateTextureFailure(error,values){
  if(error&&typeof error==='object'&&records.has(error))records.set(error,{...records.get(error),...sanitizeTextureFailure(values)})
  return error
}
export function textureFailureFields(error){return error&&typeof error==='object'?{...records.get(error)}:{}}
export function inheritTextureFailure(source,target){
  if(target&&typeof target==='object'&&source&&typeof source==='object'&&records.has(source))records.set(target,{...records.get(source)})
  return target
}
