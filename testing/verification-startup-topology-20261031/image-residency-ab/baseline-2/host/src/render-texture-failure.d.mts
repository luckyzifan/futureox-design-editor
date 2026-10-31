export const textureFailureLimits: Readonly<Record<string,number>>
export function sanitizeTextureFailure(value:unknown):Record<string,number>
export function textureAllocationError(width:number,height:number,maxDimension:number,bytesPerPixel:number):Error
export function annotateTextureFailure<T>(error:T,values:Record<string,number>):T
export function textureFailureFields(error:unknown):Record<string,number>
export function inheritTextureFailure<T>(source:unknown,target:T):T
