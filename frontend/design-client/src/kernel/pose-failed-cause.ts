/** Diagnostic snapshots only. No request ID, document reference or authority. */
export type FailedCaptureCause = Readonly<Record<string, number>>
const names = ['actionOwner','actionId','actionSession','actionStartRevision','actionCode'] as const
export function captureFailureCause(sequence:number,generation:number,epoch:number,action:Record<string,number>):FailedCaptureCause {
 const known=Number.isSafeInteger(sequence)&&sequence>0
 const fields:Record<string,number>={failedCauseKnown:Number(known),failedCauseSequence:known?sequence:0,
  failedCauseGeneration:generation,failedCauseEpoch:epoch,failedCauseActionKnown:Number(known&&action.poseActionKnown===1),causeRequestKnown:0}
 if(fields.failedCauseActionKnown)for(const name of names) {
  const value=action[name]
  if(Number.isSafeInteger(value)&&value>=0)fields['failedCause'+name[0].toUpperCase()+name.slice(1)]=value
 }
 return Object.freeze(fields)
}
export function observedFailureCause(cause:FailedCaptureCause|undefined,phase:number,attempt:number,branch:number,
 sequence:number,generation:number,epoch:number):Record<string,number> {
 return {...(cause||{failedCauseKnown:0,failedCauseActionKnown:0,causeRequestKnown:0}),
  failedCausePhase:phase,failedCauseAttempt:attempt,failedCauseBranch:branch,
  observedCurrentSequence:sequence,observedCurrentGeneration:generation,observedCurrentEpoch:epoch}
}
