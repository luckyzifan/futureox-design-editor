/** Diagnostic labels only. They never authorize a document, pose or frame. */
export type PoseActionToken = Readonly<{ actionOwner:number;actionId:number;actionSession:number;actionStartRevision:number;actionCode:number }>
function copyToken(token:PoseActionToken|undefined):PoseActionToken|undefined {
 if(!token)return
 try {
 const {actionOwner,actionId,actionSession,actionStartRevision,actionCode}=token
 if(![actionOwner,actionId,actionSession,actionStartRevision,actionCode].every(n=>Number.isSafeInteger(n)&&n>=0)||actionOwner>1e12||actionId>1e9||actionSession>1e9||actionStartRevision>1e9||actionCode>73)return
 return Object.freeze({actionOwner,actionId,actionSession,actionStartRevision,actionCode})
 } catch { return undefined }
}
/** Sequence ownership remains renderer-local. Emit interactionOwner alongside
 * these fields. Late callbacks never adopt the newest action or current props. */
export class PoseActionCorrelation {
 private tokens=new Map<number,PoseActionToken|undefined>()
 private evicted=0
 constructor(private readonly capacity=180){if(!Number.isInteger(capacity)||capacity<1||capacity>512)throw RangeError('Invalid pose diagnostic capacity')}
 bind(sequence:number,token:PoseActionToken|undefined){
  if(!Number.isSafeInteger(sequence)||sequence<=0||this.tokens.has(sequence))return
  if(this.tokens.size>=this.capacity){this.tokens.delete(this.tokens.keys().next().value!);this.evicted=Math.min(1e9,this.evicted+1)}
  this.tokens.set(sequence,copyToken(token))
 }
 inherit(source:number,target:number){this.bind(target,this.tokens.get(source))}
 fields(sequence:number,immediate?:PoseActionToken):Record<string,number>{
  // Sequence zero denotes an apply rejection before a pose was submitted.
  const token=sequence===0?copyToken(immediate):this.tokens.get(sequence)
  return {...token,poseActionKnown:Number(!!token),poseActionEvicted:this.evicted}
 }
}
