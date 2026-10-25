import {readFile} from 'node:fs/promises'
/** Recovery is not success. Keep foreground failures visible even after the
 * normal renderer falls back and clears its on-screen error label. */
export async function renderFailures(file,start,end){
 const found=new Map()
 for(const line of (await readFile(file,'utf8')).split('\n')){
  const at=line.indexOf('[render-diag] ');if(at<0)continue
  let data;try{data=JSON.parse(line.slice(at+14))}catch{continue}
  for(const row of data.batch||[data]){
   if(!['failure-origin','failure-summary','error'].includes(row.event)||!(row.at>=start&&row.at<=end))continue
   const category=row.failureCategory??row.lastFailureCategory??0
   if(category<=1)continue
   const code=row.failureCode??row.lastFailureCode??0,key=[row.session,row.requestId,category,code].join(':')
   const previous=found.get(key)||{}
   found.set(key,{...previous,at:row.at,requestId:row.requestId,category,code,recovered:!!row.recovered||!!previous.recovered,
    ...(row.failureRequestedBytes===undefined?{}:{requestedBytes:row.failureRequestedBytes,workingBytes:row.failureWorkingBytes,budgetBytes:row.failureBudgetBytes,modeTag:row.failureAllocationPassMode,mode:row.failureAllocationPassMode?row.failureAllocationPassMode-1:undefined})})
  }
 }
 return [...found.values()]
}
