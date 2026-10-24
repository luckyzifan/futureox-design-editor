// Loaded only by the copied verification host. SIGUSR2 starts/stops CPU sampling
// in this owned Electron window and its workers; it performs no UI operations.
import {BrowserWindow} from 'electron'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import path from 'node:path'
const output=process.env.CORE_OWNED_PROFILE_OUTPUT
let active,queue=Promise.resolve()
async function toggle(){
 if(!output)return
 if(!active){
  const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('design-app:'))
  if(!window)throw Error('Owned product window is unavailable')
  const debug=window.webContents.debugger,sessions=new Map(),pending=[]
  const stage=(await readFile(path.join(output,'profile-stage.txt'),'utf8')).trim()
  if(!/^[a-z0-9-]{1,80}$/.test(stage))throw Error('Invalid profile stage')
  debug.attach('1.3')
  const listener=(_event,method,params)=>{
   if(method==='Target.attachedToTarget'&&params.targetInfo.type==='worker'){
    sessions.set(params.sessionId,params.targetInfo)
    pending.push(debug.sendCommand('Profiler.enable',{},params.sessionId).then(()=>debug.sendCommand('Profiler.start',{},params.sessionId)))
   }
  }
  debug.on('message',listener);await debug.sendCommand('Profiler.enable');await debug.sendCommand('Profiler.start')
  await debug.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
  active={debug,sessions,pending,listener,stage,startedAt:Date.now()}
  await writeFile(path.join(output,'profile-status.json'),JSON.stringify({status:'sampling',stage,startedAt:active.startedAt}))
 }else{
  const s=active;active=undefined;await Promise.allSettled(s.pending)
  const directory=path.join(output,'flames',s.stage);await mkdir(directory,{recursive:true});const results=[]
  for(const [id,target] of [[undefined,{type:'renderer'}],...s.sessions])try{
   const {profile}=await s.debug.sendCommand('Profiler.stop',{},id),file=String(results.length)+'.cpuprofile'
   await writeFile(path.join(directory,file),JSON.stringify(profile));results.push({file,target})
  }catch(error){results.push({target,error:String(error)})}
  s.debug.off('message',s.listener);s.debug.detach()
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({startedAt:s.startedAt,endedAt:Date.now(),results},null,2))
  await writeFile(path.join(output,'profile-status.json'),JSON.stringify({status:'stopped',stage:s.stage,directory}))
 }
}
process.on('SIGUSR2',()=>{queue=queue.then(toggle).catch(async error=>{if(output)await writeFile(path.join(output,'profile-status.json'),JSON.stringify({status:'error',error:String(error)}))})})
