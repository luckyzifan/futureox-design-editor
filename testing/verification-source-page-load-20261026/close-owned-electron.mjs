/** Only accepts the child handle created by this test's Electron launch. */
export async function terminateOwnedProcess(child,graceMs=1500) {
  const ended=()=>child.exitCode!==null||child.signalCode!==null
  const wait=ms=>new Promise(resolve=>{
    if(ended()){resolve(true);return}
    const done=()=>{clearTimeout(timer);child.off('exit',done);resolve(true)}
    const timer=setTimeout(()=>{child.off('exit',done);resolve(ended())},ms)
    child.once('exit',done)
  })
  if(ended())return {forced:false,exited:true}
  child.kill('SIGTERM')
  if(await wait(graceMs))return {forced:false,exited:true}
  child.kill('SIGKILL')
  if(!await wait(2000))throw Error('Owned test process did not exit after SIGKILL')
  return {forced:true,exited:true}
}

export async function closeOwnedElectron(app,timeoutMs=5000) {
  const child=app.process()
  let timer,closeError
  try { await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('normal test close timed out')),timeoutMs)})]) }
  catch(error) { closeError=String(error) }
  finally { clearTimeout(timer) }
  const result=await terminateOwnedProcess(child)
  return {...result,...(closeError?{closeError}:{})}
}
