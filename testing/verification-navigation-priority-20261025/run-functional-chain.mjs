import {spawn} from 'node:child_process'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),out=path.join(root,'testing/verification-navigation-priority-20261025'),name=process.argv[2]
const host=process.env.FIG_HOST;if(!host||!name)throw Error('Explicit owned host and run name required')
const cases=[['check-fig-foreground.mjs','fig-operations-'+name],['check-117-foreground.mjs','117-operations-'+name],['check-source-workbench.mjs','sketch-operations-'+name]]
const report={host,startedAt:new Date().toISOString(),cases:[]}
for(const [script,run]of cases){
 const command=['testing/verification-drag-response-20261024/'+script,run],startedAt=new Date().toISOString()
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,command,{cwd:root,env:{...process.env,FIG_HOST:host},stdio:'inherit'});child.on('error',reject);child.on('exit',(code,signal)=>resolve(signal?{signal}:code))})
 report.cases.push({command:[process.execPath,...command],run,startedAt,endedAt:new Date().toISOString(),code})
 await writeFile(path.join(out,name+'-functional-chain.json'),JSON.stringify(report,null,2))
 if(code!==0){process.exitCode=1;break}
}
