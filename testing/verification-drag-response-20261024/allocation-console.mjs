export async function startAllocationConsole(app){
 return app.evaluate(async({BrowserWindow})=>{
  const debug=BrowserWindow.getAllWindows()[0].webContents.debugger,rows=[],pending=[]
  debug.attach('1.3')
  const listener=(_event,method,params,sessionId)=>{
   if(method==='Target.attachedToTarget'&&params.targetInfo.type==='worker')pending.push(debug.sendCommand('Runtime.enable',{},params.sessionId))
   if(method==='Runtime.consoleAPICalled'){
    const text=(params.args||[]).map(arg=>arg.value).filter(value=>typeof value==='string').join(' ')
    if(text.startsWith('DESIGN_ALLOCATION_SITE ')&&rows.length<20)rows.push({at:Date.now(),sessionId,text,stackTrace:params.stackTrace})
   }
  }
  debug.on('message',listener)
  await debug.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true})
  globalThis.__ownedAllocationConsole={debug,rows,pending,listener}
 })
}
export async function stopAllocationConsole(app){
 return app.evaluate(async()=>{
  const p=globalThis.__ownedAllocationConsole;if(!p)return []
  await Promise.allSettled(p.pending);p.debug.off('message',p.listener);p.debug.detach();delete globalThis.__ownedAllocationConsole;return p.rows
 })
}
