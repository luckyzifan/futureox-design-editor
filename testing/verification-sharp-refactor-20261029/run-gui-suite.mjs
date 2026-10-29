import fs from 'node:fs/promises'
import {openSync,closeSync} from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {buildInputs} from '../../frontend/design-desktop/scripts/build-inputs.mjs'
const root=process.cwd(),out=process.argv[2]
if(!out||!path.isAbsolute(out))throw Error('Fresh absolute suite output required')
await fs.mkdir(out)
const inputs=await buildInputs(root),build=JSON.parse(await fs.readFile('frontend/design-desktop/dist/build-manifest.json','utf8'))
if(JSON.stringify(inputs)!==JSON.stringify(build.sources))throw Error('Build/source mismatch')
const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(inputs).sort(([a],[b])=>a.localeCompare(b)))).digest('hex')
const report={sourceDigest,scope:'Sequential real GUI functionality. Other CPU unit tests may run; wall time is not a performance acceptance.',cases:[]}
for(const kind of ['117','fig','topology']){
 const target=path.join(out,kind),script=kind==='topology'?'topology-journey.ts':'gui-journey.ts'
 const log=openSync(path.join(out,kind+'.log'),'wx')
 const child=spawn('bun',[path.join('testing/verification-sharp-refactor-20261029',script),...(kind==='topology'?[]:[kind]),target],{cwd:root,stdio:['ignore',log,log]})
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
 closeSync(log);report.cases.push({kind,code,report:JSON.parse(await fs.readFile(path.join(target,'report.json'),'utf8'))})
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({kind,code}))
}
report.inputsUnchanged=JSON.stringify(await buildInputs(root))===JSON.stringify(inputs)
report.status=report.inputsUnchanged&&report.cases.every(c=>c.code===0&&c.report.status==='passed')?'passed':'failed'
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,sourceDigest}))
if(report.status!=='passed')process.exitCode=1
