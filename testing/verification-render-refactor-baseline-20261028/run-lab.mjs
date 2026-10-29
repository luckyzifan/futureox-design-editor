import fs from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import path from 'node:path'
import {spawn,execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {verifyArtifacts} from './provenance.mjs'
const root=process.cwd(),base=path.resolve(process.argv[2]||''),version=process.argv[3]||'v1'
if(!process.argv[2]||!/^v\d+$/.test(version))throw Error('Usage: node run-lab.mjs BASE vN')
const bundle=path.join(base,version),manifest=JSON.parse(await fs.readFile(path.join(bundle,'manifest.json'),'utf8'))
const artifactsBefore=await verifyArtifacts(base,bundle,manifest)
const baseline=JSON.parse(await fs.readFile(path.join(base,'baseline.json'),'utf8')),require=createRequire(import.meta.url)
const electron=require(path.join(root,'frontend/design-desktop/node_modules/electron'))
const before=createHash('sha256').update(await fs.readFile(baseline.fixture.path)).digest('hex')
if(before!==baseline.fixture.sha256)throw Error('Source fixture changed before run')
const fixtureConfig=JSON.parse(await fs.readFile(path.join(bundle,'fixture.json'),'utf8'))
if(fixtureConfig.sourceSha256&&before!==fixtureConfig.sourceSha256)throw Error('Source fixture does not match the frozen test cases')
const captureCompetition=()=>execFileSync('ps',['-axo','pid,ppid,%cpu,etime,comm'],{encoding:'utf8'}).split('\n').filter(line=>/cargo|rustc|vitest|Electron Helper|design-prepare/.test(line)).join('\n')
await fs.writeFile(path.join(bundle,'competition-before.txt'),captureCompetition())
const output=createWriteStream(path.join(bundle,'host.log'),{flags:'wx'}),env={...process.env}
delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VITE_DESIGN_')||key==='CORE_GPU_WORKING_BUDGET_MIB')delete env[key]
const child=spawn(electron,[manifest.host],{cwd:root,env,stdio:['ignore','pipe','pipe']})
let reportDir,buffer='',finished=false,finalStatus
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output.write(chunk);if(stream!==child.stdout)return;buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){
 if(line.startsWith('DESKTOP_RENDER_CHECK_OUTPUT '))reportDir=line.slice('DESKTOP_RENDER_CHECK_OUTPUT '.length).trim()
 if(line.includes('GPU TOPOLOGY CASE ')||line.includes('GPU TOPOLOGY_TEST_DONE '))console.log(line)
 if(line.includes('GPU TOPOLOGY_TEST_DONE ')){finished=true;finalStatus=JSON.parse(line.slice(line.indexOf('GPU TOPOLOGY_TEST_DONE ')+'GPU TOPOLOGY_TEST_DONE '.length)).status}
}})
// Only the child owned by this runner can be stopped by the watchdog.
const watchdog=setTimeout(()=>{console.error('Owned test exceeded 40 minute observation limit');child.kill('SIGTERM')},40*60*1000)
const code=await new Promise(resolve=>{child.on('error',error=>{console.error(error);resolve(-1)});child.on('close',resolve)})
clearTimeout(watchdog);output.end()
if(reportDir){await fs.cp(reportDir,path.join(bundle,'evidence'),{recursive:true});console.log('Evidence: '+path.join(bundle,'evidence'))}
const after=createHash('sha256').update(await fs.readFile(baseline.fixture.path)).digest('hex')
await fs.writeFile(path.join(bundle,'competition-after.txt'),captureCompetition())
let artifactsAfter,artifactError
try{artifactsAfter=await verifyArtifacts(base,bundle,manifest)}catch(error){artifactError=String(error)}
const result={code,finished,finalStatus,pid:child.pid,sourceBefore:before,sourceAfter:after,sourceUnchanged:before===after,reportDir,artifactsBefore,artifactsAfter,artifactError}
await fs.writeFile(path.join(bundle,'run.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
if(code!==0||!finished||finalStatus!=='baseline-complete'||before!==after||artifactError)process.exitCode=1
