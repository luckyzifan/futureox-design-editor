import {execFile,spawn}from'node:child_process'
import{promisify}from'node:util'
import path from'node:path'
const execute=promisify(execFile)
export async function startNativeProfiles(app,host,directory,label){
 const owner=app.process().pid,{stdout}=await execute('/bin/ps',['-axo','pid=,ppid=,command='])
 const rows=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?[{pid:+m[1],parent:+m[2],command:m[3]}]:[]})
 const descendants=new Set([owner]);let grew=true
 while(grew){grew=false;for(const row of rows)if(descendants.has(row.parent)&&!descendants.has(row.pid)){descendants.add(row.pid);grew=true}}
 const candidates=rows.filter(r=>descendants.has(r.pid)&&r.pid!==owner&&r.command.includes(host+'/dist/')&&/design-prepare|design-render|futureox-design-desktop-backend/.test(r.command))
 const jobs=candidates.map(row=>{
  const file=path.join(directory,`${label}-native-${row.pid}.sample.txt`),startedAt=Date.now()
  const child=spawn('/usr/bin/sample',[String(row.pid),'4','1','-file',file],{stdio:['ignore','pipe','pipe']})
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(output.length<4096)output+=chunk.toString()})
  const done=new Promise(resolve=>{child.once('error',error=>resolve({pid:row.pid,file,startedAt,error:String(error)}));child.once('exit',(code,signal)=>resolve({pid:row.pid,parent:row.parent,file,startedAt,endedAt:Date.now(),code,signal,output}))})
  return {done}
 })
 return {owner,candidates:candidates.map(({pid,parent})=>({pid,parent})),done:()=>Promise.all(jobs.map(job=>job.done))}
}
