import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPetController } from '../src/pet/controller.mjs'
import { createScheduler } from '../src/pet/renderer/scheduler.mjs'
import { createPetHost, PET_URL, petResource } from '../src/pet/host.mjs'
function clock() {
  let now = 0, id = 0; const timers = new Map()
  return { now: () => now, setTimer: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id }, clearTimer: id => timers.delete(id),
    count: () => timers.size,
    tick(ms) { const end = now + ms; while (true) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].fn() }; now = end },
  }
}
test('semantic reactions are bounded, coalesced by importance and contain no payload', () => {
  const time = clock(), states = [], controller = createPetController({ ...time, publish: state => states.push(state) })
  assert.equal(controller.event('edit'), false)
  controller.configure('active'); controller.event('edit')
  for (let i=0;i<1000;i++) controller.event('edit')
  controller.event('export'); controller.event('edit')
  assert.equal(states.length, 2); assert.equal(time.count(), 2)
  time.tick(900); assert.equal(states.at(-1).action, 'celebrate'); assert.equal(states.at(-1).sequence, 3)
  time.tick(1600); assert.equal(states.at(-1).action, 'idle'); assert.equal(time.count(), 0)
  assert.throws(() => controller.event({ type: 'edit', document: 'secret' }))
  assert.throws(() => controller.configure('unknown'))
  assert.deepEqual(Object.keys(states[0]).sort(), ['action','mode','paused','sequence'])
})
test('navigation priority discards queued work, quiet/off suspend all timers, dispose never resumes', () => {
  const time = clock(), states = [], c = createPetController({ ...time, publish: state => states.push(state) })
  c.configure('active'); c.event('edit'); c.event('export'); c.event('navigation-start')
  assert.equal(time.count(), 0); assert.equal(c.state().paused, true)
  assert.equal(c.event('error'), false); time.tick(9999)
  c.event('navigation-end'); assert.equal(c.state().action, 'idle')
  c.event('save'); c.configure('quiet'); assert.equal(time.count(), 0)
  assert.equal(c.event('export'), false); c.configure('active'); c.event('undo'); c.suspend(true)
  assert.equal(time.count(), 0); assert.equal(c.state().paused, true)
  c.configure('off'); c.dispose(); const n = states.length
  c.configure('active'); c.event('save'); time.tick(9999); assert.equal(states.length,n)
})
function mocks(timers = {}) {
  const windows = [], ipcMain = new EventEmitter(), app = new EventEmitter(), powerMonitor = new EventEmitter()
  let protocolHandler, requestHandler, permission, permissionCheck
  const isolated = { protocol: { handle(_name, fn) { protocolHandler=fn }, unhandle() { protocolHandler=null } },
    webRequest: { onBeforeRequest(fn) { requestHandler=fn } }, setPermissionRequestHandler(fn) { permission=fn }, setPermissionCheckHandler(fn) { permissionCheck=fn } }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options=options; this.destroyed=false; this.visible=false; this.webContents=new EventEmitter(); this.webContents.mainFrame={ url:PET_URL }; this.webContents.sent=[]; this.webContents.send=(...args)=>this.webContents.sent.push(args); this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn}; windows.push(this) }
    isDestroyed() { return this.destroyed } isVisible() { return this.visible } isMinimized() { return false }
    showInactive() { this.visible=true } hide() { this.visible=false } setIgnoreMouseEvents(value) { this.clickThrough=value }
    loadURL(url) { this.url=url; return Promise.resolve() }
    destroy() { this.destroyed=true; this.emit('closed') }
  }
  const editor = new Window({}); editor.visible=true
  const host = createPetHost({ BrowserWindow:Window, ipcMain, app, powerMonitor, timers,
    session:{ fromPartition(name) { assert.equal(name,'futureox-pet-v1'); return isolated } }, screen:{ getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1200,height:900}}) } })
  host.attachEditor(editor)
  return { host, windows, editor, ipcMain, app, powerMonitor, get protocolHandler(){return protocolHandler}, get requestHandler(){return requestHandler}, get permission(){return permission}, get permissionCheck(){return permissionCheck} }
}
test('mocked Electron contract: opt-in single window, sandbox, exact sender and lifecycle cleanup', () => {
  const m=mocks(); assert.equal(m.windows.length,1)
  m.host.configure('active'); const pet=m.windows[1]; m.host.configure('active'); assert.equal(m.windows.length,2)
  assert.equal(pet.options.webPreferences.sandbox,true); assert.equal(pet.options.webPreferences.contextIsolation,true)
  assert.equal(pet.options.webPreferences.nodeIntegration,false); assert.equal(pet.options.webPreferences.webSecurity,true)
  assert.equal(pet.options.focusable,false); assert.equal(pet.clickThrough,true); assert.equal(pet.visible,false)
  m.ipcMain.emit('design-pet:ready',{sender:m.editor.webContents,senderFrame:m.editor.webContents.mainFrame}); assert.equal(pet.visible,false)
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:{url:PET_URL}}); assert.equal(pet.visible,false)
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame}); assert.equal(pet.visible,true)
  assert.deepEqual(pet.openHandler(),{action:'deny'})
  let permission; m.permission(null,'camera',v=>permission=v); assert.equal(permission,false); assert.equal(m.permissionCheck(),false)
  let cancelled; m.requestHandler({url:'https://example.com'},v=>cancelled=v.cancel); assert.equal(cancelled,true)
  m.host.event('navigation-start'); assert.equal(pet.webContents.sent.at(-1)[1].paused,true)
  m.editor.visible=false; m.editor.emit('hide'); assert.equal(pet.visible,false)
  m.editor.visible=true; m.editor.emit('show'); assert.equal(pet.visible,true)
  m.powerMonitor.emit('lock-screen'); m.powerMonitor.emit('suspend'); assert.equal(pet.visible,false); m.powerMonitor.emit('resume'); assert.equal(pet.visible,false); m.powerMonitor.emit('unlock-screen'); assert.equal(pet.visible,true)
  m.host.configure('off'); assert.equal(pet.destroyed,true)
  m.host.configure('quiet'); assert.equal(m.windows.length,3)
  m.host.dispose(); assert.equal(m.windows[2].destroyed,true); assert.equal(m.ipcMain.listenerCount('design-pet:ready'),0)
  assert.equal(m.editor.listenerCount('hide'),0); assert.equal(m.powerMonitor.listenerCount('suspend'),0)
  assert.equal(m.protocolHandler,null); assert.equal(m.requestHandler,null)
})
test('mocked GPU crash trips pet without disabling editor GPU or retry loop', () => {
  const m=mocks(); m.host.configure('active'); m.app.emit('child-process-gone',{}, {type:'GPU'})
  assert.equal(m.windows[1].destroyed,true); assert.equal(m.host.configure('active').failed,true); assert.equal(m.windows.length,2)
  m.host.configure('off'); assert.equal(m.host.configure('active').failed,false); assert.equal(m.windows.length,3); m.host.dispose()
})
test('resource serving rejects remote, subdomain, traversal, symlink escape and non-GET', async () => {
  const base=await mkdtemp(path.join(tmpdir(),'pet-resource-')); const root=path.join(base,'inside')
  const {mkdir}=await import('node:fs/promises'); await mkdir(root)
  try {
    await writeFile(path.join(root,'index.html'),'pet'); await writeFile(path.join(base,'outside.js'),'secret'); await symlink(path.join(base,'outside.js'),path.join(root,'escape.js'))
    let response=await petResource(root,{url:PET_URL,method:'GET'}); assert.equal(response.status,200); assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none'/)
    for (const url of ['https://pet/index.html','design-pet://pet.evil/index.html','design-pet://pet/%2e%2e%2foutside.js','design-pet://pet/escape.js','design-pet://pet/index.html?secret=1']) assert.notEqual((await petResource(root,{url,method:'GET'})).status,200)
    assert.equal((await petResource(root,{url:PET_URL,method:'POST'})).status,403)
  } finally { await rm(base,{recursive:true,force:true}) }
})

test('actual controller revisions drive scheduler pause, idle and quiet transitions', () => {
  const frames=new Map(); let id=0; const scheduler=createScheduler({ requestFrame(fn){frames.set(++id,fn);return id},cancelFrame(id){frames.delete(id)},draw(){},clear(){} })
  const time=clock(), controller=createPetController({...time,publish:state=>scheduler.setState(state)})
  scheduler.setVisible(true); controller.configure('active'); assert.equal(frames.size,1)
  controller.event('edit'); controller.event('navigation-start'); assert.equal(frames.size,0)
  controller.event('navigation-end'); assert.equal(frames.size,1)
  controller.configure('quiet'); assert.equal(frames.size,0)
  controller.configure('active'); controller.suspend(true); assert.equal(frames.size,0)
  controller.suspend(false); assert.equal(frames.size,1)
  controller.dispose(); scheduler.dispose(); assert.equal(frames.size,0)
})

test('unready window is bounded and its watchdog is cleaned on ready/off', () => {
  const time=clock(), m=mocks(time); m.host.configure('active'); assert.equal(time.count(),1)
  time.tick(10000); assert.equal(m.windows[1].destroyed,true); assert.equal(time.count(),0)
  m.host.configure('off'); m.host.configure('active'); const pet=m.windows[2]
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame}); assert.equal(time.count(),0)
  m.host.configure('off'); m.host.configure('quiet'); assert.equal(time.count(),1)
  m.host.dispose(); assert.equal(time.count(),0)
})

test('health reports starting, verified ready and async crash/load failure without polling', () => {
  const m=mocks(), reply=m.host.configure('active'), pet=m.windows[1]
  assert.equal(reply.phase,'starting'); assert.equal(reply.ok,true)
  const statuses=()=>m.editor.webContents.sent.filter(([channel])=>channel==='design-desktop:pet-status').map(([,value])=>value)
  assert.equal(statuses().at(-1).phase,'starting')
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame})
  assert.equal(statuses().at(-1).phase,'ready')
  const readyCount=statuses().length
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame}); assert.equal(statuses().length,readyCount)
  pet.webContents.emit('render-process-gone'); assert.equal(statuses().at(-1).phase,'unavailable')
  assert.equal(statuses().at(-1).mode,'off')
  m.host.configure('off'); m.host.configure('quiet');
  pet.webContents.emit('did-fail-load'); assert.equal(statuses().at(-1).phase,'starting')
  m.windows[2].webContents.emit('did-fail-load')
  assert.equal(statuses().at(-1).phase,'unavailable')
  for(let i=1;i<statuses().length;i++) assert.ok(statuses()[i].revision>statuses()[i-1].revision)
  m.host.dispose(); const count=statuses().length
  pet.webContents.emit('render-process-gone'); assert.equal(statuses().length,count)
})

test('loading renderer stays hidden across mode, editor and power changes until trusted ready', () => {
  const time=clock(), m=mocks(time); m.host.configure('active'); const pet=m.windows[1]
  let shows=0, hides=0
  const show=pet.showInactive.bind(pet), hide=pet.hide.bind(pet)
  pet.showInactive=()=>{ shows++; show() }; pet.hide=()=>{ hides++; hide() }
  m.host.configure('quiet'); assert.equal(pet.visible,false)
  m.host.configure('active'); m.host.event('edit'); assert.equal(pet.visible,false)
  m.editor.visible=false; m.editor.emit('hide'); m.editor.visible=true; m.editor.emit('show')
  assert.equal(pet.visible,false)
  m.powerMonitor.emit('suspend'); m.powerMonitor.emit('resume')
  m.powerMonitor.emit('lock-screen'); m.powerMonitor.emit('unlock-screen')
  assert.equal(pet.visible,false); assert.equal(shows,0)
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:{url:PET_URL}})
  assert.equal(shows,0); assert.equal(time.count(),1)
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame})
  assert.equal(pet.visible,true); assert.equal(shows,1); assert.equal(time.count(),0)
  m.host.configure('quiet'); m.host.configure('active'); m.host.event('save')
  m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame})
  assert.equal(shows,1) // No hide/show flicker during state updates or duplicate ready.
  assert.equal(hides,2) // Explicit suspend/lock handlers only while still loading.
  m.host.dispose(); assert.equal(time.count(),0)
})

test('trusted ready does not override hidden editor, lock, suspension, off or failed ownership', () => {
  for (const condition of ['hidden','locked','suspended','off','failed','timeout']) {
    const time=clock(), m=mocks(time); m.host.configure('active'); const pet=m.windows[1]
    let shows=0; const show=pet.showInactive.bind(pet); pet.showInactive=()=>{shows++;show()}
    if(condition==='hidden') {m.editor.visible=false;m.editor.emit('hide')}
    if(condition==='locked') m.powerMonitor.emit('lock-screen')
    if(condition==='suspended') m.powerMonitor.emit('suspend')
    if(condition==='off') m.host.configure('off')
    if(condition==='failed') pet.webContents.emit('did-fail-load')
    if(condition==='timeout') time.tick(10000)
    m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame})
    assert.equal(shows,0,condition)
    if(condition==='hidden') {m.editor.visible=true;m.editor.emit('show')}
    if(condition==='locked') m.powerMonitor.emit('unlock-screen')
    if(condition==='suspended') m.powerMonitor.emit('resume')
    if(['hidden','locked','suspended'].includes(condition)) assert.equal(shows,1,condition)
    else {
      m.host.configure('off'); m.host.configure('quiet'); const replacement=m.windows[2]
      m.ipcMain.emit('design-pet:ready',{sender:pet.webContents,senderFrame:pet.webContents.mainFrame})
      assert.equal(replacement.visible,false)
      m.ipcMain.emit('design-pet:ready',{sender:replacement.webContents,senderFrame:replacement.webContents.mainFrame})
      assert.equal(replacement.visible,true)
    }
    m.host.dispose(); assert.equal(time.count(),0)
  }
})
